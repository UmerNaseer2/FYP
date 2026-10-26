/**
 * Saving and restoring a backup of everything Schema Studio keeps.
 *
 * A backup holds every row of the web app's tables, the key that unlocks the
 * saved database passwords, the GitHub token and a few settings. It is locked
 * with a passphrase, so it is safe on a USB stick or in a cloud folder.
 *
 * Saving reads every table in one read-only transaction, so the backup is one
 * consistent moment even while the app keeps working. Each value is saved as
 * PostgreSQL's own text for it, which turns back into exactly the same value.
 *
 * Restoring has two steps, so a wrong passphrase or a damaged file is found
 * before anything changes. Checking reads the whole file and makes sure it
 * opens and fits this version of the app. Loading replaces every table in one
 * transaction, all or nothing, and leaves a marker on the database. The
 * backup's secrets wait in a file until the next start finds that marker
 * (finishPendingRestore), so the data and the secrets switch together even if
 * the computer stops halfway.
 *
 * The file format is src/core/backup-file.ts. Tested in src/test/backup.test.ts.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { DatabaseError, type Client } from "pg";

import {
  BackupFileError,
  ChunkOpener,
  ChunkSealer,
  ContentsReader,
  encodeRecord,
  HEADER_BYTES,
  newBackupKey,
  newRestoreId,
  openBackupKey,
  parseBackupManifest,
  passphraseProblem,
  readBackupHeader,
  RecordReader,
  restoreComment,
  restoreIdFromComment,
  type BackupChoices,
  type BackupItem,
  type BackupManifest,
  type BackupSecrets,
  type BackupSequence,
  type BackupTable,
  type PendingRestore,
} from "../core/backup-file";
import { DB_NAME } from "../core/postgres-files";
import { addLogSecret, logInfo, logWarn } from "./log";
import { quoteIdent, withClient } from "./postgres";
import type { ProtectedStore } from "./secrets";
import { StartupError } from "./startup-error";

/** How much of a backup file is read at a time. */
const READ_BYTES = 1024 * 1024;

/** Sealed chunks are gathered up and written about this much at a time. */
const WRITE_BYTES = 1024 * 1024;

/**
 * How many rows saving fetches at a time: few enough that big rows (the
 * snapshot of a large schema can be megabytes) never pile up in memory, and
 * enough that small rows do not each wait for a round trip of their own.
 */
const FETCH_ROWS = 20;

/** Restoring sends rows in batches of at most this many rows, */
const BATCH_ROWS = 500;

/** or of about this many characters of row text, whichever comes first. */
const BATCH_TEXT = 8 * 1024 * 1024;

/** The column types whose highest value a counter has to stay past. */
const INTEGER_TYPES = new Set(["smallint", "integer", "bigint"]);

const STILL_SETTING_UP = "Schema Studio is still setting up its database. Wait a moment, then try again.";
const CHANGED = "The backup file changed after it was checked, so nothing was restored. Choose it again, then try again.";
const DOES_NOT_FIT = new BackupFileError("does-not-fit").message;
const NO_SPACE = "There is not enough free space to save the backup there. Free some space or choose another folder, then try again.";
const CANNOT_WRITE = "Schema Studio cannot write to that folder. Choose another folder, then try again.";
const CANNOT_READ = "Schema Studio is not allowed to read that file. Choose another one.";

/** The start screen's title when a restore cannot be finished. DesktopApp's own problems while finishing one use it too. */
export const FINISH_RESTORE_TITLE = "Schema Studio could not finish restoring the backup";
const PENDING_LOCKED =
  'The keys of the backup you restored are locked with your login keyring, and the keyring did not open. Log out and back in, or unlock the "Login" keyring in Passwords and Keys, then press Try again.';

/** What to tell the person when the backup cannot be written where they chose, by the system's error code. */
const SAVE_FILE_PROBLEMS = new Map([
  ["ENOSPC", NO_SPACE],
  ["EDQUOT", NO_SPACE],
  ["EACCES", CANNOT_WRITE],
  ["EPERM", CANNOT_WRITE],
  ["EROFS", CANNOT_WRITE],
  ["ENOENT", "That folder is not there anymore. Choose another folder, then try again."],
  ["ENAMETOOLONG", "Schema Studio cannot save a file with that name. Choose a shorter name, then try again."],
  ["EISDIR", "There is already a folder with that name. Choose another name, then try again."],
]);

/** What to tell the person when the backup they chose cannot be opened, by the system's error code. */
const READ_FILE_PROBLEMS = new Map([
  ["ENOENT", "Schema Studio cannot find that file anymore. Choose it again."],
  ["EACCES", CANNOT_READ],
  ["EPERM", CANNOT_READ],
]);

/**
 * Settings for one transaction, so PostgreSQL writes each value the same way
 * whatever its own settings say, and reads it back as the same value: dates
 * in ISO order, times in UTC, numbers with every digit and bytes as hex.
 * Quoted text keeps its backslashes as they are, which quoteLiteral needs.
 */
const STEADY_SETTINGS = [
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  "SET LOCAL TimeZone = 'UTC'",
  "SET LOCAL extra_float_digits = 3",
  "SET LOCAL bytea_output = 'hex'",
  "SET LOCAL standard_conforming_strings = on",
];

/**
 * Every table of the app's schema with the columns a backup can hold, which
 * are all but the ones computed from the others. A table with none of those
 * comes back as one row with no column.
 *
 * The type to cast to is the column's type without its size, such as
 * character varying rather than character varying(10), so the column applies
 * its size when a value is stored: a cast to the sized type would cut a value
 * short instead of refusing it.
 */
const LIVE_TABLES = `
  SELECT c.relname::text AS "table", c.relkind::text AS kind, a.attname::text AS "column",
    format_type(a.atttypid, -1) AS "castType",
    a.attnotnull AND NOT a.atthasdef AND a.attidentity = '' AS required,
    pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS sequence
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  ORDER BY c.relname, a.attnum`;

/**
 * The links between tables (foreign keys) that start in the app's schema,
 * each with its columns in order. A link copied onto each part of a
 * partitioned table is left out, since the link on the whole table covers it,
 * and so is one that was never checked against the rows already there.
 */
const LINKS = `
  SELECT con.conname::text AS name, c.relname::text AS "table", c.relkind::text AS kind,
    fn.nspname::text AS "refSchema", f.relname::text AS "refTable", f.relkind::text AS "refKind",
    con.confmatchtype::text AS match,
    array_agg(a.attname::text ORDER BY k.i) AS columns,
    array_agg(fa.attname::text ORDER BY k.i) AS "refColumns"
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class f ON f.oid = con.confrelid
  JOIN pg_namespace fn ON fn.oid = f.relnamespace
  CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(col, refcol, i)
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.col
  JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.refcol
  WHERE con.contype = 'f' AND con.conparentid = 0 AND con.convalidated AND n.nspname = 'public'
  GROUP BY con.oid, con.conname, c.relname, c.relkind, fn.nspname, f.relname, f.relkind, con.confmatchtype
  ORDER BY c.relname, con.conname`;

/**
 * Which table of the app's schema points to which, by name, for working out
 * which tables a restore empties. Unlike LINKS, this keeps the links that were
 * never checked, since PostgreSQL refuses to empty a table any link points to
 * unless the table the link starts in is emptied in the same statement. A link
 * into or out of one part of a partitioned table counts as the whole table's,
 * since a restore empties a partitioned table with all its parts.
 */
const TABLE_LINKS = `
  SELECT DISTINCT c.relname::text AS "table", f.relname::text AS "refTable"
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = coalesce(pg_partition_root(con.conrelid), con.conrelid)
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class f ON f.oid = coalesce(pg_partition_root(con.confrelid), con.confrelid)
  JOIN pg_namespace fn ON fn.oid = f.relnamespace
  WHERE con.contype = 'f' AND n.nspname = 'public' AND fn.nspname = 'public'`;

/**
 * The indexes behind the rules that keep rows apart (primary keys, unique and
 * exclusion rules) that are allowed to wait until a transaction ends. Each
 * part of a partitioned table holds such a rule, and its index, for its own
 * rows.
 */
const WAITING_RULES = `
  SELECT format('%I.%I', ixn.nspname, ix.relname) AS index
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_class home ON home.oid = coalesce(pg_partition_root(c.oid), c.oid)
  JOIN pg_namespace n ON n.oid = home.relnamespace
  JOIN pg_class ix ON ix.oid = con.conindid
  JOIN pg_namespace ixn ON ixn.oid = ix.relnamespace
  WHERE con.contype IN ('p', 'u', 'x') AND con.condeferrable AND c.relkind = 'r' AND n.nspname = 'public'
  ORDER BY 1`;

/**
 * A problem with a backup that the person can do something about. Its
 * message is written for them and can be shown as it is; anything else that
 * goes wrong is unexpected, and its details belong in the log.
 */
export class BackupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupError";
  }
}

export type SaveBackupOptions = {
  /** The folder that holds the database's socket. */
  socketDir: string;
  /** Where to save the backup. */
  file: string;
  passphrase: string;
  /** The version of the running app, which the backup records. */
  appVersion: string;
  /** The secrets the backup carries, so the saved database passwords open again wherever it is restored. */
  secrets: BackupSecrets;
  config: BackupChoices;
  /** How slow the passphrase is to try; tests choose the lowest, to run fast. */
  cost?: number;
  /** When the backup was made, if not now. */
  now?: Date;
};

export type CheckBackupOptions = {
  /** The folder that holds the database's socket. */
  socketDir: string;
  /** The backup the person chose. */
  file: string;
  passphrase: string;
  /** The version of the running app, which a backup from a newer one does not fit. */
  appVersion: string;
};

/** A backup that checkBackup opened and found fitting, with what loadBackup needs to restore it. */
export type CheckedBackup = {
  file: string;
  /** The first bytes of the file, which have to be the same when it is read again. */
  header: Buffer;
  /** The key that opens the file, so restoring does not need the passphrase again. */
  key: Buffer;
  manifest: BackupManifest;
};

export type LoadBackupOptions = {
  /** The folder that holds the database's socket. */
  socketDir: string;
  backup: CheckedBackup;
  /** The version of the running app. */
  appVersion: string;
  /** Keeps the backup's secrets safe until the next start; called just before the restore commits. */
  writePending(pending: PendingRestore): void;
  /** Throws those secrets away again, when the restore did not go in after all. */
  removePending(): void;
};

/** restore-pending.json, which keeps a restore's secrets and settings until the next start finishes it. */
export type PendingRestoreStore = Pick<ProtectedStore<PendingRestore>, "load" | "remove">;

export type FinishRestoreOptions = {
  /** The folder that holds the database's socket. */
  socketDir: string;
  pending: PendingRestoreStore;
  /**
   * Puts the backup's secrets and settings in place of the ones in use. Throws
   * when it cannot, which leaves the restore waiting for the next start.
   */
  apply(pending: PendingRestore): Promise<void>;
};

/** A column of a table in the app's database that a backup can hold. */
type LiveColumn = {
  name: string;
  /** The column's type without its size, for turning text back into a value of it. */
  castType: string;
  /** Whether every row needs a value for it: it cannot be empty and has nothing to fill it in. */
  required: boolean;
  /** The counter that numbers new rows in it, already quoted as SQL, or null if it has none. */
  sequence: string | null;
};

/** A table of the app's database, as it is right now. */
type LiveTable = {
  name: string;
  /** "p" for a partitioned table, "r" for any other. */
  kind: string;
  columns: LiveColumn[];
};

/** A table of the backup, with the SQL that puts a batch of its rows into this database. */
type Fit = { table: BackupTable; insert: string };

/** A link from one table of the app's schema to another, as TABLE_LINKS gives it. */
type TableLink = { table: string; refTable: string };

/**
 * Saves a backup of the app's database, with `secrets` and `config`, to
 * `file`, locked with `passphrase`. Throws a BackupError when it cannot, with
 * words for the person, and any other error when something unexpected went
 * wrong.
 */
export async function saveBackup(options: SaveBackupOptions): Promise<void> {
  const problem = passphraseProblem(options.passphrase);
  if (problem !== null) throw new BackupError(problem);
  try {
    const { header, key } = await newBackupKey(options.passphrase, { cost: options.cost });
    await withClient(options.socketDir, DB_NAME, async (client) => {
      // One moment for every table, which the app's own writes carry on around.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        await setSteadySettings(client);
        const live = await readLiveTables(client);
        if (live.size === 0) throw new BackupError(STILL_SETTING_UP);
        // A table needs a column to be in a backup. Restoring empties a table
        // without any, as it does every table the backup does not have.
        const counted: { table: LiveTable; rows: number }[] = [];
        for (const table of live.values()) {
          if (table.columns.length > 0) counted.push({ table, rows: await countRows(client, table) });
        }
        const manifest = checkedManifest(
          {
            appVersion: options.appVersion,
            createdAt: (options.now ?? new Date()).toISOString(),
            secrets: options.secrets,
            config: options.config,
            tables: counted.map(({ table, rows }) => ({ name: table.name, columns: table.columns.map((column) => column.name), rows })),
            sequences: await readCounters(client, counted.map(({ table }) => table)),
          },
          options.appVersion,
        );
        await writeBackupFile(options.file, header, key, async (put) => {
          await put(encodeRecord(JSON.stringify(manifest)));
          for (const { table, rows } of counted) await putRows(client, table, rows, put);
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  } catch (error) {
    throw asBackupError(error);
  }
}

/**
 * Opens the backup in `file` with `passphrase`, reads all of it and makes
 * sure it fits this database, without changing anything. Gives back what
 * loadBackup needs to restore it. Throws a BackupError when the backup cannot
 * be restored, with words for the person.
 */
export async function checkBackup(options: CheckBackupOptions): Promise<CheckedBackup> {
  try {
    const handle = await openForReading(options.file);
    try {
      const header = readBackupHeader(await readStart(handle));
      const key = await openBackupKey(header, options.passphrase);
      // Checking only needs every row to be there and intact, so it keeps none of them.
      const manifest = await readContents(handle, header.bytes, key, options.appVersion, async () => {});
      fitTables(manifest, await withClient(options.socketDir, DB_NAME, readLiveTables));
      return { file: options.file, header: header.bytes, key, manifest };
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (error) {
    throw asBackupError(error);
  }
}

/**
 * Replaces the tables of the app's database with the rows of a backup that
 * checkBackup checked, all in one transaction, and marks the database with
 * which restore went in. A table the backup does not have is emptied, unless
 * the backup's rows point to it (see tablesToKeep). The backup's secrets go to `writePending` just
 * before the transaction commits, and to `removePending` when it turns out
 * not to, so the next start switches to them only if the data switched too.
 * Throws a BackupError when the backup cannot be restored, and then nothing
 * has changed.
 */
export async function loadBackup(options: LoadBackupOptions): Promise<void> {
  try {
    const handle = await openForReading(options.backup.file);
    try {
      // The file is read a second time, so it has to be the very one that was checked.
      if (!(await readStart(handle)).equals(options.backup.header)) throw new BackupError(CHANGED);
      await withClient(options.socketDir, DB_NAME, (client) => replaceTables(client, handle, options));
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (error) {
    throw fromDatabase(error);
  }
}

/** The id of the last restore that went into the app's database, or null if there was none. */
export async function readRestoreMarker(socketDir: string): Promise<string | null> {
  return withClient(socketDir, DB_NAME, async (client) => {
    const result = await client.query<{ comment: string | null }>(
      "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
      [DB_NAME],
    );
    return restoreIdFromComment(result.rows[0]?.comment);
  });
}

/**
 * Finishes a restore that loadBackup left waiting, if there is one. When the
 * database carries that restore's marker, its rows are the backup's, so the
 * backup's secrets and settings are put in place too. When it does not, the
 * restore never went in, and its secrets are thrown away. Runs at every start,
 * once the database is up and before the web app starts, since the web app
 * needs the key that opens the saved passwords in the rows it finds.
 *
 * Says what it found: "none" when no restore was waiting, "finished", or
 * "not-in". Throws a StartupError when the restore's secrets are locked, and
 * whatever `apply` throws.
 */
export async function finishPendingRestore(options: FinishRestoreOptions): Promise<"none" | "finished" | "not-in"> {
  const loaded = options.pending.load();
  if (loaded.status === "missing") return "none";
  if (loaded.status === "locked") {
    // Kept, since the keyring may open next time, and the rows may already be the backup's.
    logWarn(loaded.message);
    throw new StartupError(FINISH_RESTORE_TITLE, PENDING_LOCKED);
  }
  if (loaded.status === "damaged") {
    // Nothing in it can be used. If its restore went in, the saved passwords
    // no longer open, and restoring the backup again puts that right.
    logWarn(`${loaded.message} If a backup was being restored, restore it again.`);
    dropPending(() => options.pending.remove());
    return "none";
  }
  const pending = loaded.values;
  if ((await readRestoreMarker(options.socketDir)) !== pending.id) {
    // The secrets are kept just before the restore commits, so a stop at that
    // moment leaves them waiting beside rows that never changed.
    logInfo("A backup was being restored when Schema Studio stopped, and it did not go in, so nothing changed.");
    dropPending(() => options.pending.remove());
    return "not-in";
  }
  // In use from here on, so the log must never show them.
  addLogSecret(pending.secrets.appEncryptionKey);
  addLogSecret(pending.secrets.githubToken);
  await options.apply(pending);
  // Last, so a stop before this finds the marker and the file again at the
  // next start, which puts the same secrets and settings in place again.
  dropPending(() => options.pending.remove());
  logInfo("Finished restoring the backup.");
  return "finished";
}

/** The rest of loadBackup, on its connection to the database. */
async function replaceTables(client: Client, handle: FileHandle, options: LoadBackupOptions): Promise<void> {
  const { backup } = options;
  const id = newRestoreId();
  let pendingWritten = false;
  await client.query("BEGIN");
  try {
    await setSteadySettings(client);
    // Rows go in table by table, so a row can arrive before the row it points
    // to. Replica mode skips checking the links between tables, and the rules
    // that may wait until the end too, so both are checked once every row is in.
    await client.query("SET LOCAL session_replication_role = replica");
    // The server is stopped while a backup goes in, so nothing should hold a table for long.
    await client.query("SET LOCAL lock_timeout = '30s'");
    const live = await readLiveTables(client);
    const fits = new Map(fitTables(backup.manifest, live).map((fit) => [fit.table.name, fit]));
    const kept = tablesToKeep(live, backup.manifest, (await client.query<TableLink>(TABLE_LINKS)).rows);
    const emptied = new Map([...live].filter(([name]) => !kept.has(name)));
    // PostgreSQL empties a table that another table points to only together
    // with that table, so every table is emptied in one statement. The list
    // is never empty: fitTables made sure there is a table, and only a table
    // the backup's rows point to is kept, so a backup without tables keeps none.
    const tables = [...emptied.values()].map((table) => relation("public", table.name, table.kind));
    await client.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY`);

    let batch: { fit: Fit; rows: string[]; text: number } | null = null;
    const send = async (): Promise<void> => {
      if (batch === null) return;
      const { fit, rows } = batch;
      batch = null;
      const result = await client.query(fit.insert, [`[${rows.join(",")}]`]);
      // Each row is one object, so a row holding more than one would put in rows the backup does not have.
      if (result.rowCount !== rows.length) throw new BackupFileError("damaged");
    };
    const manifest = await readContents(handle, backup.header, backup.key, options.appVersion, async (item) => {
      if (item.kind === "manifest") {
        if (JSON.stringify(item.manifest) !== JSON.stringify(backup.manifest)) throw new BackupError(CHANGED);
        return;
      }
      if (batch !== null && (batch.fit.table.name !== item.table.name || batch.rows.length >= BATCH_ROWS || batch.text + item.row.length > BATCH_TEXT)) {
        await send();
      }
      if (batch === null) {
        const fit = fits.get(item.table.name);
        if (fit === undefined) throw new BackupFileError("damaged");
        batch = { fit, rows: [], text: 0 };
      }
      batch.rows.push(item.row);
      batch.text += item.row.length;
    });
    await send();
    await checkWaitingRules(client);
    // A kept table's rows and counter are as they were, so its counter stays where it stands.
    await setCounters(client, emptied, manifest);
    await checkLinks(client);
    await client.query(`COMMENT ON DATABASE ${quoteIdent(DB_NAME)} IS ${quoteLiteral(restoreComment(id))}`);
    pendingWritten = true;
    options.writePending({ id, secrets: manifest.secrets, config: manifest.config });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (pendingWritten) dropPending(options.removePending);
    throw error;
  }
  try {
    const result = await client.query("COMMIT");
    // PostgreSQL answers COMMIT with ROLLBACK when the transaction had already failed.
    if (result.command !== "COMMIT") throw new Error(`Expected the restore to commit, but PostgreSQL answered ${result.command}.`);
  } catch (error) {
    // A COMMIT whose answer was lost may have gone through all the same, and the marker says whether it did.
    const marker = await readRestoreMarker(options.socketDir).catch(() => undefined);
    if (marker === id) return;
    // If even that is unknown, the secrets stay waiting, and the next start decides by the marker.
    if (marker !== undefined) dropPending(options.removePending);
    throw error;
  }
}

/** Every table of the app's schema, by name, with the columns a backup can hold. */
async function readLiveTables(client: Client): Promise<Map<string, LiveTable>> {
  const result = await client.query<{
    table: string;
    kind: string;
    column: string | null;
    castType: string | null;
    required: boolean | null;
    sequence: string | null;
  }>(LIVE_TABLES);
  const tables = new Map<string, LiveTable>();
  for (const row of result.rows) {
    let table = tables.get(row.table);
    if (table === undefined) {
      table = { name: row.table, kind: row.kind, columns: [] };
      tables.set(row.table, table);
    }
    if (row.column === null) continue;
    if (row.castType === null) throw new Error(`Expected a type for the ${row.column} column of the ${row.table} table, but it had none.`);
    table.columns.push({ name: row.column, castType: row.castType, required: row.required === true, sequence: row.sequence });
  }
  return tables;
}

/**
 * Makes sure every table and column of the backup is in this database, and
 * that every row of the backup can go in, then gives the SQL for each table.
 * Throws a BackupError when the backup does not fit.
 */
function fitTables(manifest: BackupManifest, live: Map<string, LiveTable>): Fit[] {
  // The web app makes its tables just after its server first starts, so a
  // database without any is one that is still being set up.
  if (live.size === 0) throw new BackupError(STILL_SETTING_UP);
  return manifest.tables.map((table) => {
    const target = live.get(table.name);
    if (target === undefined) throw doesNotFit(`This database has no ${table.name} table.`);
    const columns = table.columns.map((name) => {
      const column = target.columns.find((candidate) => candidate.name === name);
      if (column === undefined) throw doesNotFit(`The ${table.name} table of this database has no ${name} column.`);
      return column;
    });
    // A column the backup does not have is filled in by its default, which a required column does not have.
    const unfilled = target.columns.find((column) => column.required && !table.columns.includes(column.name));
    if (table.rows > 0 && unfilled !== undefined) {
      throw doesNotFit(`The backup's ${table.name} table has no ${unfilled.name} column, which every row needs here.`);
    }
    const names = columns.map((column) => quoteIdent(column.name)).join(", ");
    const values = columns.map((column) => `(r->>${quoteLiteral(column.name)})::${column.castType}`).join(", ");
    // OVERRIDING SYSTEM VALUE lets the saved numbers into identity columns, which otherwise always number rows themselves.
    const insert = `INSERT INTO "public".${quoteIdent(table.name)} (${names}) OVERRIDING SYSTEM VALUE SELECT ${values} FROM json_array_elements($1::json) AS batch(r)`;
    return { table, insert };
  });
}

/**
 * The tables of the app's database that a restore leaves as they are, rows
 * and counters both: each table the backup does not have that the backup's
 * rows point to, and each table the backup does not have that a kept table
 * points to in turn. Every other table is emptied.
 *
 * This is for a backup made before a table its rows now point to existed.
 * The one that matters is a backup from before organizations: its tables
 * have no org_id column, so their rows go in under the default organization
 * (org_id has a default on the desktop, see settleOrgIdDefaults in the web
 * app's lib/db/bootstrap.ts), and that only works if the organizations table
 * keeps its rows. Its memberships table is emptied, since nothing in the
 * backup points to it, and the next start gives everyone back the role their
 * restored profile carries (backfillMemberships in the same file).
 *
 * A kept table that points to a table being emptied is emptied as well,
 * because PostgreSQL refuses to empty a table while a table it leaves alone
 * points to it. Rows of the backup that point into such a table then break
 * their link, and checkLinks refuses the backup, with nothing changed.
 */
function tablesToKeep(live: Map<string, LiveTable>, manifest: BackupManifest, links: TableLink[]): Set<string> {
  const inBackup = new Set(manifest.tables.map((table) => table.name));
  const kept = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const link of links) {
      const from = inBackup.has(link.table) || kept.has(link.table);
      if (from && live.has(link.refTable) && !inBackup.has(link.refTable) && !kept.has(link.refTable)) {
        kept.add(link.refTable);
        grew = true;
      }
    }
  }
  for (let shrank = true; shrank; ) {
    shrank = false;
    for (const link of links) {
      if (kept.has(link.table) && live.has(link.refTable) && !kept.has(link.refTable)) {
        kept.delete(link.table);
        shrank = true;
      }
    }
  }
  return kept;
}

/** How many rows `table` has. */
async function countRows(client: Client, table: LiveTable): Promise<number> {
  const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${relation("public", table.name, table.kind)}`);
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count)) throw new Error(`Expected a count of the rows in the ${table.name} table, but got ${String(result.rows[0]?.count)}.`);
  return count;
}

/** Where the counter of each column of `tables` that has one stands. */
async function readCounters(client: Client, tables: LiveTable[]): Promise<BackupSequence[]> {
  const counters: BackupSequence[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.sequence === null) continue;
      const result = await client.query<{ lastValue: string; isCalled: boolean }>(
        `SELECT last_value::text AS "lastValue", is_called AS "isCalled" FROM ${column.sequence}`,
      );
      const counter = result.rows[0];
      if (counter === undefined) throw new Error(`Expected the counter of the ${column.name} column of the ${table.name} table to have a value, but it had none.`);
      counters.push({ table: table.name, column: column.name, lastValue: counter.lastValue, isCalled: counter.isCalled });
    }
  }
  return counters;
}

/**
 * Gives a manifest the same checks restoring will, so a backup that saves is
 * one that restores, and keeps only the fields a manifest has.
 */
function checkedManifest(manifest: BackupManifest, appVersion: string): BackupManifest {
  try {
    return parseBackupManifest(JSON.stringify(manifest), appVersion);
  } catch (error) {
    throw new Error("Expected the backup's contents to pass its own checks, but they did not.", { cause: error });
  }
}

/** Hands every row of `table` to `put`, a few at a time, each as a JSON object of PostgreSQL's text for its values. */
async function putRows(client: Client, table: LiveTable, expected: number, put: (record: Buffer) => Promise<void>): Promise<void> {
  const columns = table.columns.map((column) => `${quoteIdent(column.name)}::text AS ${quoteIdent(column.name)}`).join(", ");
  // r.* is the whole row, even when one of its columns is called r.
  await client.query(
    `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT row_to_json(r.*)::text AS row FROM (SELECT ${columns} FROM ${relation("public", table.name, table.kind)}) AS r`,
  );
  let fetched = 0;
  for (;;) {
    const result = await client.query<{ row: string }>(`FETCH ${FETCH_ROWS} FROM backup_rows`);
    for (const { row } of result.rows) await put(encodeRecord(row));
    fetched += result.rows.length;
    if (result.rows.length < FETCH_ROWS) break;
  }
  await client.query("CLOSE backup_rows");
  // The rows were counted in the same moment they were read, so the two always agree.
  if (fetched !== expected) throw new Error(`Expected ${expected} rows in the ${table.name} table, but read ${fetched}.`);
}

/**
 * Puts each counter that numbers new rows back where the backup had it, and
 * moves it on past the highest number in its column if the backup had it
 * behind, so a new row never takes a number that is already used. A counter
 * that counts down is left where the backup had it.
 */
async function setCounters(client: Client, live: Map<string, LiveTable>, manifest: BackupManifest): Promise<void> {
  for (const table of live.values()) {
    for (const column of table.columns) {
      if (column.sequence === null) continue;
      const saved = manifest.sequences.find((sequence) => sequence.table === table.name && sequence.column === column.name);
      let value = saved?.lastValue;
      let isCalled = saved?.isCalled ?? false;
      if (INTEGER_TYPES.has(column.castType)) {
        const result = await client.query<{ top: string | null; up: boolean | null }>(
          `SELECT (SELECT max(${quoteIdent(column.name)})::text FROM ${relation("public", table.name, table.kind)}) AS top,
            (SELECT seqincrement > 0 FROM pg_sequence WHERE seqrelid = $1::regclass) AS up`,
          [column.sequence],
        );
        const top = result.rows[0]?.top ?? null;
        if (result.rows[0]?.up === true && top !== null && !givesPast(value, isCalled, top)) {
          value = top;
          isCalled = true;
        }
      }
      if (value !== undefined) await client.query("SELECT setval($1::regclass, $2::bigint, $3)", [column.sequence, value, isCalled]);
    }
  }
}

/**
 * Whether a counter that counts up, standing at `value`, gives a number past
 * `top` next: `value` itself if it was never used, or the one after it.
 */
function givesPast(value: string | undefined, isCalled: boolean, top: string): boolean {
  if (value === undefined) return false;
  return isCalled ? BigInt(value) >= BigInt(top) : BigInt(value) > BigInt(top);
}

/**
 * Checks every link between tables against the restored rows, as PostgreSQL
 * would have row by row. Throws a BackupError when a row points to nothing.
 */
async function checkLinks(client: Client): Promise<void> {
  const result = await client.query<{
    name: string;
    table: string;
    kind: string;
    refSchema: string;
    refTable: string;
    refKind: string;
    match: string;
    columns: string[];
    refColumns: string[];
  }>(LINKS);
  for (const link of result.rows) {
    const values = link.columns.map((name) => `child.${quoteIdent(name)}`).join(", ");
    const same = link.columns.map((name, index) => `parent.${quoteIdent(link.refColumns[index])} = child.${quoteIdent(name)}`).join(" AND ");
    const missing = `NOT EXISTS (SELECT 1 FROM ${relation(link.refSchema, link.refTable, link.refKind)} AS parent WHERE ${same})`;
    // A MATCH FULL link has all its columns empty or all filled in. Any other
    // link only counts when every one of its columns is filled in.
    const broken =
      link.match === "f"
        ? `(num_nonnulls(${values}) > 0 AND num_nulls(${values}) > 0) OR (num_nulls(${values}) = 0 AND ${missing})`
        : `num_nulls(${values}) = 0 AND ${missing}`;
    const found = await client.query(`SELECT 1 FROM ${relation("public", link.table, link.kind)} AS child WHERE ${broken} LIMIT 1`);
    if (found.rows.length > 0) throw doesNotFit(`A row of the ${link.table} table breaks its ${link.name} link.`);
  }
}

/**
 * Checks the rules that keep rows apart and are allowed to wait until the
 * end. While a restore goes in, PostgreSQL skips those altogether, even at the
 * end, so each of their indexes is built again, which refuses rows that break
 * the rule. The rules that never wait check each row as it goes in.
 */
async function checkWaitingRules(client: Client): Promise<void> {
  const result = await client.query<{ index: string }>(WAITING_RULES);
  for (const { index } of result.rows) await client.query(`REINDEX INDEX ${index}`);
}

async function setSteadySettings(client: Client): Promise<void> {
  for (const setting of STEADY_SETTINGS) await client.query(setting);
}

/**
 * A table as SQL. A partitioned table is read and emptied with all its parts;
 * any other table only by itself, since a table that inherits from it is in
 * the backup as a table of its own.
 */
function relation(schema: string, name: string, kind: string): string {
  return `${kind === "p" ? "" : "ONLY "}${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Text as an SQL string. Only a quote needs doubling, since the steady settings keep backslashes as they are. */
function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Writes a backup under a hidden name beside `file` first, and puts it in
 * place only once it is complete and on the disk, so a save that fails never
 * leaves half a backup, nor spoils one already there. `write` hands every
 * record to the `put` it is given, in order.
 */
async function writeBackupFile(file: string, header: Buffer, key: Buffer, write: (put: (record: Buffer) => Promise<void>) => Promise<void>): Promise<void> {
  const folder = path.dirname(file);
  const temp = path.join(folder, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  // "wx" refuses to open a file that is already there, so nothing planted
  // under the temporary name is ever written through. The umask can only take
  // permissions away from 0o600, so the file is this user's alone either way.
  const handle = await onFile(() => fs.promises.open(temp, "wx", 0o600));
  let open = true;
  try {
    await onFile(() => writeAll(handle, header));
    const sealer = new ChunkSealer(key, header);
    let sealed: Buffer[] = [];
    let sealedBytes = 0;
    const flush = async (): Promise<void> => {
      const data = Buffer.concat(sealed);
      sealed = [];
      sealedBytes = 0;
      await onFile(() => writeAll(handle, data));
    };
    await write(async (record) => {
      for (const chunk of sealer.write(record)) {
        sealed.push(chunk);
        sealedBytes += chunk.length;
      }
      if (sealedBytes >= WRITE_BYTES) await flush();
    });
    sealed.push(sealer.end());
    await flush();
    await onFile(() => handle.sync());
    open = false;
    await onFile(() => handle.close());
    await onFile(() => fs.promises.rename(temp, file));
  } catch (error) {
    if (open) {
      await handle.close().catch(() => {
        // Already failing; the original error is the one worth reporting.
      });
    }
    await fs.promises.unlink(temp).catch(() => {
      // Nothing left to tidy, or nothing more to be done about it.
    });
    throw error;
  }
  await syncFolder(folder);
}

/** Writes all of `data`, however many writes that takes. */
async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const { bytesWritten } = await handle.write(data, written, data.length - written, null);
    if (bytesWritten === 0) throw new Error("Expected the backup file to take more bytes, but nothing was written.");
    written += bytesWritten;
  }
}

/**
 * Forces the folder onto the disk too, since the rename is written down in the
 * folder itself. Some file systems cannot do that for a folder; the backup is
 * already complete there, so this is best effort.
 */
async function syncFolder(folder: string): Promise<void> {
  try {
    const handle = await fs.promises.open(folder, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort, as above.
  }
}

/** Runs a step that writes the backup file, and turns the problems a person can fix into words that say how. */
async function onFile<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const message = SAVE_FILE_PROBLEMS.get(errorCode(error) ?? "");
    throw message === undefined ? error : new BackupError(message, { cause: error });
  }
}

/**
 * Opens a backup to read, once it is sure to be a plain file. Opening does not
 * wait, so a named pipe cannot hold it up; a plain file reads the same either
 * way.
 */
async function openForReading(file: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    const message = READ_FILE_PROBLEMS.get(errorCode(error) ?? "");
    throw message === undefined ? error : new BackupError(message, { cause: error });
  }
  try {
    if (!(await handle.stat()).isFile()) throw new BackupFileError("not-a-backup");
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  return handle;
}

/** Reads the start of the file, as much of it as a backup's header takes. */
async function readStart(handle: FileHandle): Promise<Buffer> {
  const start = Buffer.alloc(HEADER_BYTES);
  let filled = 0;
  while (filled < HEADER_BYTES) {
    const { bytesRead } = await handle.read(start, filled, HEADER_BYTES - filled, null);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return start.subarray(0, filled);
}

/**
 * Reads the rest of the file after its header: opens each chunk, splits the
 * records apart and hands each item to `take`, in order. Gives back the
 * manifest once the whole file is read and every row it promised was there.
 */
async function readContents(
  handle: FileHandle,
  header: Buffer,
  key: Buffer,
  appVersion: string,
  take: (item: BackupItem) => Promise<void>,
): Promise<BackupManifest> {
  const opener = new ChunkOpener(key, header);
  const records = new RecordReader();
  const contents = new ContentsReader(appVersion);
  const hand = async (opened: Buffer[]): Promise<void> => {
    for (const plain of opened) {
      for (const record of records.push(plain)) await take(contents.read(record));
    }
  };
  for (;;) {
    // A new buffer for each read: after a short read, which a network drive can give mid-file, the
    // opener holds on to this buffer until it has a whole chunk, so the next read must not write over it.
    const buffer = Buffer.allocUnsafe(READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, null);
    if (bytesRead === 0) break;
    await hand(opener.write(buffer.subarray(0, bytesRead)));
  }
  await hand([opener.end()]);
  records.end();
  return contents.end();
}

/**
 * Throws away a restore's waiting secrets. If that fails, the next start
 * finds them again: they go then when no marker matches them, and when one
 * does, the restore is finished again. So a failure is only logged.
 */
function dropPending(removePending: () => void): void {
  try {
    removePending();
  } catch (error) {
    logWarn("Could not remove the waiting secrets of a restore; the next start looks at them again.", error);
  }
}

/** The backup does not fit this database. `detail` says how, for the log. */
function doesNotFit(detail: string): BackupError {
  return new BackupError(DOES_NOT_FIT, { cause: new Error(detail) });
}

/** A backup file's problem, in the same form as every other problem a person can fix. */
function asBackupError(error: unknown): unknown {
  return error instanceof BackupFileError ? new BackupError(error.message, { cause: error }) : error;
}

/**
 * A value the database refuses (class 22, data exceptions) or a rule it
 * enforces (class 23, integrity violations) means the backup does not fit
 * this database. Any other error stays as it is.
 */
function fromDatabase(error: unknown): unknown {
  if (error instanceof DatabaseError && /^2[23]/.test(error.code ?? "")) return new BackupError(DOES_NOT_FIT, { cause: error });
  return asBackupError(error);
}

/** The error code the system gave, such as ENOSPC, if there is one. */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}
