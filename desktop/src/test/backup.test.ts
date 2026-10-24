/**
 * Saving, checking and restoring backups (src/main/backup.ts) against a real
 * PostgreSQL, the same build the .deb carries: every kind of value the app's
 * tables hold comes back exactly, the counters that number new rows carry on
 * past the restored rows, and a backup that is damaged, changed, locked with
 * another passphrase or does not fit is refused with nothing changed.
 *
 * The tests need build/postgres for this computer (npm run fetch:postgres)
 * and are skipped without it, except in the desktop workflow, which fetches it.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  BackupFileError,
  ChunkOpener,
  ChunkSealer,
  encodeRecord,
  HEADER_BYTES,
  MIN_COST,
  newBackupKey,
  newRestoreId,
  openBackupKey,
  passphraseProblem,
  readBackupHeader,
  RecordReader,
  type BackupChoices,
  type BackupManifest,
  type BackupSecrets,
  type PendingRestore,
} from "../core/backup-file";
import { resolveAppPaths } from "../core/paths";
import { DB_NAME } from "../core/postgres-files";
import {
  BackupError,
  checkBackup,
  finishPendingRestore,
  loadBackup,
  readRestoreMarker,
  saveBackup,
  type CheckedBackup,
  type PendingRestoreStore,
} from "../main/backup";
import { logSecrets } from "../main/log";
import { quoteIdent, startPostgres, withClient, type RunningPostgres } from "../main/postgres";
import type { LoadResult } from "../main/secrets";
import { StartupError } from "../main/startup-error";

// The socket then goes in the test's own folder, not the runtime folder every app of this user shares.
delete process.env.XDG_RUNTIME_DIR;

const installDir = path.resolve(__dirname, "../../build/postgres", `${process.platform}-${process.arch}`);
const available = fs.existsSync(path.join(installDir, "bin", "postgres"));
const appVersion = "1.0.0";
const config: BackupChoices = { theme: "dark", github: { owner: "octocat", repo: "schema-registry" } };
const DOES_NOT_FIT = new BackupFileError("does-not-fit").message;
const DAMAGED = new BackupFileError("damaged").message;
const NOT_A_BACKUP = new BackupFileError("not-a-backup").message;
const WRONG_PASSPHRASE = new BackupFileError("wrong-passphrase").message;
const NEWER = new BackupFileError("newer").message;
const CHANGED = "The backup file changed after it was checked, so nothing was restored. Choose it again, then try again.";
const STILL_SETTING_UP = "Schema Studio is still setting up its database. Wait a moment, then try again.";
const FINISH_TITLE = "Schema Studio could not finish restoring the backup";
const PENDING_LOCKED =
  'The keys of the backup you restored are locked with your login keyring, and the keyring did not open. Log out and back in, or unlock the "Login" keyring in Passwords and Keys, then press Try again.';

let pg: RunningPostgres | undefined;
let base = "";

before(async () => {
  if (!available) return;
  // A short name, since the socket's path has to fit in about 100 bytes.
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ssb-"));
  const paths = resolveAppPaths(
    { XDG_CONFIG_HOME: path.join(base, "c"), XDG_DATA_HOME: path.join(base, "d"), XDG_STATE_HOME: path.join(base, "s") },
    base,
  );
  pg = await startPostgres({ installDir, paths, signal: new AbortController().signal });
});

after(async () => {
  await pg?.stop();
  if (base !== "") fs.rmSync(base, { recursive: true, force: true });
});

/** Whether `t` is skipped, because there is no PostgreSQL to run it against. */
function skipped(t: test.TestContext): boolean {
  if (available) return false;
  // The desktop workflow fetches PostgreSQL and sets this, so there the tests can never be skipped by accident.
  assert.notEqual(process.env.REQUIRE_TEST_POSTGRES, "1", `There is no PostgreSQL in ${installDir}.`);
  t.skip("there is no PostgreSQL for this computer (npm run fetch:postgres puts one in build/postgres)");
  return true;
}

/** The folder of the test database's socket. */
function socketDir(): string {
  if (pg === undefined) throw new Error("Expected the test database to be running, but it is not.");
  return pg.socketDir;
}

/** Runs `sql`, which may be several statements, on the app's database. */
async function run(sql: string): Promise<void> {
  await withClient(socketDir(), DB_NAME, async (client) => {
    await client.query(sql);
  });
}

/** The rows that `sql` gives. */
async function rows<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return withClient(socketDir(), DB_NAME, async (client) => (await client.query<T>(sql, values)).rows);
}

/** Empties the database for the next test, as it is before the app has made its tables. */
async function reset(): Promise<void> {
  // Settings a test gave the database go too, so they never reach the next test.
  await run(`DROP SCHEMA IF EXISTS other CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER DATABASE ${quoteIdent(DB_NAME)} RESET ALL`);
}

/**
 * Every row of each of `tables`, as PostgreSQL writes rows out, to compare
 * one moment with another. Read without ONLY, so a partitioned table shows the
 * rows of all its parts. (No table here has a column called x, which would be
 * read in place of the whole row.)
 */
async function fingerprint(...tables: string[]): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {};
  for (const table of tables) {
    const result = await rows<{ row: string }>(`SELECT x::text AS row FROM "public".${quoteIdent(table)} AS x ORDER BY 1`);
    found[table] = result.map(({ row }) => row);
  }
  return found;
}

/** How many rows `table` has, and a sum of all of them, for a table too big to compare row by row. */
async function digest(table: string): Promise<string> {
  const [row] = await rows<{ sum: string }>(
    `SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, ',' ORDER BY x::text)), '') AS sum FROM "public".${quoteIdent(table)} AS x`,
  );
  return row.sum;
}

/** The id of a new row in `table`, which is the number its counter gives next. */
async function nextId(table: string, values = "DEFAULT VALUES"): Promise<number> {
  const [row] = await rows<{ id: number }>(`INSERT INTO "public".${quoteIdent(table)} ${values} RETURNING id`);
  return row.id;
}

/** A new empty folder for one test, removed when the test ends. */
function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-studio-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A passphrase made fresh on every run, so the repository holds none. */
function passphrase(): string {
  return crypto.randomBytes(12).toString("base64url");
}

/** Secrets made fresh on every run, in the form the app keeps them. */
function secrets(): BackupSecrets {
  return { appEncryptionKey: crypto.randomBytes(32).toString("hex"), githubToken: `test${crypto.randomBytes(8).toString("hex")}` };
}

/** A saved backup, and what it was saved with. */
type Saved = { file: string; pass: string; secrets: BackupSecrets };

/** Saves a backup of the database as it is now, as backup.ssbackup in `dir`. */
async function save(dir: string, version = appVersion): Promise<Saved> {
  const saved = { file: path.join(dir, "backup.ssbackup"), pass: passphrase(), secrets: secrets() };
  await saveBackup({
    socketDir: socketDir(),
    file: saved.file,
    passphrase: saved.pass,
    appVersion: version,
    secrets: saved.secrets,
    config,
    cost: MIN_COST,
  });
  return saved;
}

/** Checks a saved backup, as the app does before it restores one. */
function check(saved: Saved, pass = saved.pass): Promise<CheckedBackup> {
  return checkBackup({ socketDir: socketDir(), file: saved.file, passphrase: pass, appVersion });
}

/** What a restore handed over to keep until the next start, and how many times it took that back. */
type Kept = { pending: PendingRestore[]; removed: number };

/** Restores a checked backup, keeping in `kept` what it hands over. */
function restore(backup: CheckedBackup, kept: Kept = { pending: [], removed: 0 }): Promise<void> {
  return loadBackup({
    socketDir: socketDir(),
    backup,
    appVersion,
    writePending: (pending) => {
      kept.pending.push(pending);
    },
    removePending: () => {
      kept.removed += 1;
    },
  });
}

/** A stand-in for restore-pending.json that gives `loaded`, and notes in `calls` each time it is removed. */
function pendingFile(loaded: LoadResult<PendingRestore>, calls: string[]): PendingRestoreStore {
  return {
    load: () => loaded,
    remove: () => {
      calls.push("remove");
    },
  };
}

/** What restore-pending.json gives when it holds `pending`. */
function holding(pending: PendingRestore): LoadResult<PendingRestore> {
  return { status: "values", values: pending, protection: "plain", upgrade: false };
}

/** What a BackupError's cause says: its words for the log, or the database's error code. */
type Why = { cause?: string; code?: string };

/** A check for assert.rejects that the error is a BackupError saying `message`, for the reason in `why`. */
function backupError(message: string, why: Why = {}): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof BackupError, `Expected a BackupError, but got ${String(error)}.`);
    assert.equal(error.message, message);
    const cause = error.cause as { message?: unknown; code?: unknown } | undefined;
    if (why.cause !== undefined) assert.equal(cause?.message, why.cause);
    if (why.code !== undefined) assert.equal(cause?.code, why.code);
    return true;
  };
}

/**
 * Restores `backup`, which has to be refused with `message` for the reason in
 * `why`, and checks that nothing changed: not the rows of `tables`, not the
 * database's mark of the last restore, and no secrets were handed over.
 */
async function refused(backup: CheckedBackup, message: string, tables: string[], why: Why = {}): Promise<void> {
  const was = await fingerprint(...tables);
  const marker = await readRestoreMarker(socketDir());
  const kept: Kept = { pending: [], removed: 0 };
  await assert.rejects(restore(backup, kept), backupError(message, why));
  assert.deepEqual(await fingerprint(...tables), was);
  assert.equal(await readRestoreMarker(socketDir()), marker);
  assert.deepEqual(kept, { pending: [], removed: 0 });
}

/** The records of a backup file, opened with `pass`: the manifest's JSON first, then each row's. */
async function readRecords(file: string, pass: string): Promise<string[]> {
  const data = fs.readFileSync(file);
  const header = readBackupHeader(data.subarray(0, HEADER_BYTES));
  const key = await openBackupKey(header, pass);
  const opener = new ChunkOpener(key, header.bytes);
  const reader = new RecordReader();
  const records = [...opener.write(Buffer.from(data.subarray(HEADER_BYTES))), opener.end()].flatMap((plain) => reader.push(plain));
  reader.end();
  return records;
}

/** Writes `records` to `file` as a backup locked with `lock`, the same way saveBackup writes one. */
function craft(file: string, lock: { header: Buffer; key: Buffer }, records: string[]): void {
  const sealer = new ChunkSealer(lock.key, lock.header);
  const sealed = records.flatMap((text) => sealer.write(encodeRecord(text)));
  fs.writeFileSync(file, Buffer.concat([lock.header, ...sealed, sealer.end()]));
}

test("every kind of value comes back exactly as it was saved", async (t) => {
  if (skipped(t)) return;
  await reset();
  const q = quoteIdent;
  const odd = `Mixed Case "Quoted" O'Brien`;
  const note = `Note's "text"`;
  // Text with accents, an emoji, a backslash, a new line, a tab and quotes,
  // JSON that is only a string or only null, the edges of numbers and dates,
  // arrays with their own bounds or with NULLs in them, and a column called r
  // like the name the save gives each row.
  await run(`
    CREATE TABLE kinds (
      id serial PRIMARY KEY, "r" text, doc jsonb, raw bytea, amount numeric, big bigint, ratio double precision,
      happened timestamptz, plain_time timestamp, day date, span interval, name varchar(20), code char(6), flags bit(4),
      many_flags bit(3)[], moments timestamptz[], grid integer[], tags text[], yes boolean,
      doubled integer GENERATED ALWAYS AS (length("r") * 2) STORED
    );
    INSERT INTO kinds ("r", doc, raw, amount, big, ratio, happened, plain_time, day, span, name, code, flags, many_flags, moments, grid, tags, yes) VALUES
      ('caf' || chr(233) || ' ' || chr(128273) || ' back' || chr(92) || 'slash' || chr(10) || 'next line' || chr(9) || 'tab ''single'' "double"',
       '"just a string"', decode('00ff10', 'hex'), 'NaN', '9223372036854775807', 'NaN',
       '2026-10-24 13:14:15.123456+05:30', '2028-02-29 10:00:00.5', '2026-10-24', '1 year 2 months 3 days 04:05:06.789',
       'twenty characters ok', 'ab', B'1010', ARRAY[B'101', B'010'], ARRAY['2026-01-01 00:00:00+00', NULL]::timestamptz[],
       '[0:1][1:2]={{1,2},{3,4}}', ARRAY['a,b', 'quote''s "here"', NULL, '', 'NULL', 'back' || chr(92) || 'slash'], true),
      ('', 'null', '', 'Infinity', '-9223372036854775808', 'Infinity', 'infinity', '-infinity', 'infinity', '-1 days +02:00',
       '', '', B'0000', '{}', '{}', '{}', '{}', false),
      (NULL, NULL, NULL, '123456789012345678901234567890.123456789012345678901234567890', NULL, '-0', '-infinity', NULL, '4713-01-01 BC', '0',
       NULL, 'abcdef', NULL, NULL, NULL, NULL, NULL, NULL),
      ('plain', '{"nested": {"list": [1, 2.5, "three", null, true], "empty": {}}, "big": 123456789012345678901234567890}', decode('5c27', 'hex'),
       '-0.00000000000000000000000000000100', '0', '0.1', '0044-03-15 12:00:00+00 BC', '1999-12-31 23:59:59.999999', NULL, NULL,
       'x', NULL, B'1111', ARRAY[NULL, B'111']::bit(3)[], '{infinity,-infinity}', '{{1,NULL},{3,4}}', ARRAY['{braces}', ' spaced '], true);
    CREATE TABLE ${q(odd)} (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, ${q(note)} text NOT NULL);
    INSERT INTO ${q(odd)} (${q(note)}) VALUES ('one'), ('two'), ('three');
    DELETE FROM ${q(odd)} WHERE id = 2;
  `);
  const was = await fingerprint("kinds", odd);
  const dir = tempDir(t);
  const file = path.join(dir, "backup.ssbackup");
  const pass = passphrase();
  const values = secrets();
  await saveBackup({
    socketDir: socketDir(),
    file,
    passphrase: pass,
    appVersion,
    // Anything more than the secrets a backup holds stays out of it.
    secrets: Object.assign({ notASecret: "kept out" }, values),
    config,
    cost: MIN_COST,
    now: new Date("2026-01-02T03:04:05.006Z"),
  });
  // Only this user can read the backup.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  await run(`
    DELETE FROM kinds WHERE id = 1;
    UPDATE kinds SET "r" = 'changed', doc = '{"changed": true}' WHERE id = 2;
    INSERT INTO kinds ("r") VALUES ('new'), ('newer');
    INSERT INTO ${q(odd)} (${q(note)}) VALUES ('four');
    CREATE TABLE later (id serial PRIMARY KEY, v text);
    INSERT INTO later (v) VALUES ('gone after the restore');
  `);
  const backup = await checkBackup({ socketDir: socketDir(), file, passphrase: pass, appVersion });
  // The generated column is left out, since PostgreSQL works it out again.
  assert.deepEqual(backup.manifest.tables, [
    { name: odd, columns: ["id", note], rows: 2 },
    {
      name: "kinds",
      columns: ["id", "r", "doc", "raw", "amount", "big", "ratio", "happened", "plain_time", "day", "span", "name", "code", "flags", "many_flags", "moments", "grid", "tags", "yes"],
      rows: 4,
    },
  ]);
  assert.deepEqual(backup.manifest.sequences, [
    { table: odd, column: "id", lastValue: "3", isCalled: true },
    { table: "kinds", column: "id", lastValue: "4", isCalled: true },
  ]);
  assert.deepEqual(backup.manifest.secrets, values);
  assert.deepEqual(backup.manifest.config, config);
  assert.equal(backup.manifest.createdAt, "2026-01-02T03:04:05.006Z");
  assert.ok(!(await readRecords(file, pass))[0].includes("notASecret"), "Expected only a backup's own secrets in the backup.");

  const kept: Kept = { pending: [], removed: 0 };
  await restore(backup, kept);
  assert.deepEqual(await fingerprint("kinds", odd), was);
  // A table the backup does not have is emptied, and numbers its rows from the start again.
  assert.deepEqual(await rows("SELECT count(*)::int AS n FROM later"), [{ n: 0 }]);
  assert.equal(await nextId("later", "(v) VALUES ('after')"), 1);
  // Each counter carries on from where it stood, past the row deleted before the backup too.
  assert.equal(await nextId("kinds"), 5);
  assert.equal(await nextId(odd, `(${q(note)}) VALUES ('next')`), 4);
  assert.equal(kept.pending.length, 1);
  assert.equal(kept.pending[0].id, await readRestoreMarker(socketDir()));
  assert.deepEqual(kept.pending[0].secrets, values);
  assert.deepEqual(kept.pending[0].config, config);
  assert.equal(kept.removed, 0);
});

test("values come back exactly whichever way the database is set to write and read them", async (t) => {
  if (skipped(t)) return;
  await reset();
  const db = quoteIdent(DB_NAME);
  const slash = `back${String.fromCharCode(92)}slash`;
  await run(`
    CREATE TABLE written (day date, span interval, ratio double precision, ${quoteIdent(slash)} text);
    INSERT INTO written VALUES ('2026-10-24', '-1 days -02:00:00', 0.1::float8 + 0.2::float8, 'kept');
  `);
  const was = await fingerprint("written");
  // Where the backup is saved, the database writes dates day first, intervals
  // the SQL standard's way and doubles cut short.
  await run(`
    ALTER DATABASE ${db} SET DateStyle = 'SQL, DMY';
    ALTER DATABASE ${db} SET IntervalStyle = 'sql_standard';
    ALTER DATABASE ${db} SET extra_float_digits = -15;
  `);
  const saved = await save(tempDir(t));
  // Where it is restored, it reads dates month first, and a backslash in quotes as the start of an escape.
  await run(`
    ALTER DATABASE ${db} RESET ALL;
    ALTER DATABASE ${db} SET DateStyle = 'SQL, MDY';
    ALTER DATABASE ${db} SET standard_conforming_strings = off;
  `);
  const backup = await check(saved);
  await run("DELETE FROM written");
  await restore(backup);
  await run(`ALTER DATABASE ${db} RESET ALL`);
  assert.deepEqual(await fingerprint("written"), was);
});

test("rows linked across tables come back, whatever the order of their tables", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run(`
    CREATE TABLE parent (id serial PRIMARY KEY, a int, b int, UNIQUE (a, b));
    CREATE TABLE child (id serial PRIMARY KEY, parent_id int, CONSTRAINT child_parent_link FOREIGN KEY (parent_id) REFERENCES parent (id));
    CREATE TABLE pair (a int, b int, CONSTRAINT pair_parent_link FOREIGN KEY (a, b) REFERENCES parent (a, b) MATCH FULL);
    CREATE TABLE loose (a int, b int, CONSTRAINT loose_parent_link FOREIGN KEY (a, b) REFERENCES parent (a, b));
    CREATE TABLE zone (at int PRIMARY KEY) PARTITION BY RANGE (at);
    CREATE TABLE zone_low PARTITION OF zone FOR VALUES FROM (0) TO (10);
    CREATE TABLE zone_high PARTITION OF zone FOR VALUES FROM (10) TO (20);
    CREATE TABLE visit (at int, CONSTRAINT visit_zone_link FOREIGN KEY (at) REFERENCES zone (at));
    INSERT INTO parent (a, b) VALUES (1, 10), (2, 20);
    INSERT INTO child (parent_id) VALUES (1), (2), (NULL);
    INSERT INTO pair VALUES (1, 10), (NULL, NULL);
    INSERT INTO loose VALUES (2, 20), (1, NULL), (NULL, 99);
    INSERT INTO zone VALUES (1), (11);
    INSERT INTO visit VALUES (1), (11);
  `);
  const tables = ["parent", "child", "pair", "loose", "zone", "visit"];
  const was = await fingerprint(...tables);
  const backup = await check(await save(tempDir(t)));
  await run("DELETE FROM child; DELETE FROM pair; DELETE FROM loose; DELETE FROM visit; DELETE FROM parent; DELETE FROM zone; INSERT INTO parent (a, b) VALUES (3, 30)");
  // Each table that points to another comes before it by name, so its rows go
  // in before the rows they point to. PostgreSQL also keeps a copy of visit's
  // link for each part of zone, but visit points into both parts, so only the
  // link to the whole of zone holds.
  await restore(backup);
  assert.deepEqual(await fingerprint(...tables), was);
});

test("a row that breaks a link is refused with nothing changed", async (t) => {
  if (skipped(t)) return;
  const dir = tempDir(t);
  const cases = [
    // A row that points to a row that is not there.
    {
      setup: "CREATE TABLE child (parent_id int); INSERT INTO child VALUES (1), (7)",
      fix: "DELETE FROM child WHERE parent_id = 7",
      link: "FOREIGN KEY (parent_id) REFERENCES parent (id)",
    },
    // The same, from a table in parts.
    {
      setup:
        "CREATE TABLE child (at int, parent_id int) PARTITION BY RANGE (at); CREATE TABLE child_low PARTITION OF child FOR VALUES FROM (0) TO (10); INSERT INTO child VALUES (1, 1), (2, 7)",
      fix: "DELETE FROM child WHERE parent_id = 7",
      link: "FOREIGN KEY (parent_id) REFERENCES parent (id)",
    },
    // A link that has to be all filled in or all empty, half filled in.
    {
      setup: "CREATE TABLE child (a int, b int); INSERT INTO child VALUES (1, 10), (1, NULL)",
      fix: "DELETE FROM child WHERE b IS NULL",
      link: "FOREIGN KEY (a, b) REFERENCES parent (a, b) MATCH FULL",
    },
    // The same kind of link, all filled in, pointing to a row that is not there.
    {
      setup: "CREATE TABLE child (a int, b int); INSERT INTO child VALUES (1, 10), (5, 50)",
      fix: "DELETE FROM child WHERE a = 5",
      link: "FOREIGN KEY (a, b) REFERENCES parent (a, b) MATCH FULL",
    },
  ];
  for (const { setup, fix, link } of cases) {
    await reset();
    await run(`CREATE TABLE parent (id serial PRIMARY KEY, a int, b int, UNIQUE (a, b)); INSERT INTO parent (a, b) VALUES (1, 10); ${setup}`);
    const saved = await save(dir);
    // The link is made after the backup, which still has the row that breaks it.
    await run(`${fix}; ALTER TABLE child ADD CONSTRAINT child_parent_link ${link}`);
    await refused(await check(saved), DOES_NOT_FIT, ["parent", "child"], { cause: "A row of the child table breaks its child_parent_link link." });
  }

  // A link made NOT VALID is one the database itself lets older rows break, so a restore does too.
  await reset();
  await run("CREATE TABLE parent (id serial PRIMARY KEY); INSERT INTO parent DEFAULT VALUES; CREATE TABLE child (parent_id int); INSERT INTO child VALUES (1), (7)");
  const was = await fingerprint("parent", "child");
  const saved = await save(dir);
  await run("ALTER TABLE child ADD CONSTRAINT child_parent_link FOREIGN KEY (parent_id) REFERENCES parent (id) NOT VALID; DELETE FROM child");
  await restore(await check(saved));
  assert.deepEqual(await fingerprint("parent", "child"), was);
});

test("the counters that number new rows carry on past every restored row", async (t) => {
  if (skipped(t)) return;
  await reset();
  // ahead's rows were numbered by hand, so its counter never moved, edge's
  // was set back to give 5 again, a number one of its rows has, and gap's was
  // set on to give 7, past every row. twice has two counters, the second one
  // past its rows.
  await run(`
    CREATE TABLE ahead (id serial PRIMARY KEY);
    INSERT INTO ahead (id) SELECT generate_series(1, 10);
    CREATE TABLE edge (id serial PRIMARY KEY);
    INSERT INTO edge (id) SELECT generate_series(1, 5);
    SELECT setval(pg_get_serial_sequence('edge', 'id'), 5, false);
    CREATE TABLE gap (id serial PRIMARY KEY);
    INSERT INTO gap (id) SELECT generate_series(1, 3);
    SELECT setval(pg_get_serial_sequence('gap', 'id'), 7, false);
    CREATE TABLE twice (note text, a serial, b serial);
    INSERT INTO twice DEFAULT VALUES;
    INSERT INTO twice DEFAULT VALUES;
    INSERT INTO twice DEFAULT VALUES;
    SELECT setval(pg_get_serial_sequence('twice', 'b'), 9);
    CREATE TABLE down (id integer GENERATED BY DEFAULT AS IDENTITY (INCREMENT BY -1) PRIMARY KEY);
    INSERT INTO down DEFAULT VALUES;
    INSERT INTO down DEFAULT VALUES;
    INSERT INTO down DEFAULT VALUES;
    CREATE TABLE lost (id serial PRIMARY KEY);
    INSERT INTO lost DEFAULT VALUES;
    INSERT INTO lost DEFAULT VALUES;
    INSERT INTO lost DEFAULT VALUES;
  `);
  const saved = await save(tempDir(t));
  const records = await readRecords(saved.file, saved.pass);
  const manifest = JSON.parse(records[0]) as BackupManifest;
  assert.deepEqual(manifest.sequences, [
    { table: "ahead", column: "id", lastValue: "1", isCalled: false },
    { table: "down", column: "id", lastValue: "-3", isCalled: true },
    { table: "edge", column: "id", lastValue: "5", isCalled: false },
    { table: "gap", column: "id", lastValue: "7", isCalled: false },
    { table: "lost", column: "id", lastValue: "3", isCalled: true },
    { table: "twice", column: "a", lastValue: "3", isCalled: true },
    { table: "twice", column: "b", lastValue: "9", isCalled: true },
  ]);
  // A backup without lost's counter, as one saved before that column had a
  // counter would be. The restore still moves the counter past lost's rows.
  const pass = passphrase();
  craft(saved.file, await newBackupKey(pass, { cost: MIN_COST }), [
    JSON.stringify({ ...manifest, sequences: manifest.sequences.filter((sequence) => sequence.table !== "lost") }),
    ...records.slice(1),
  ]);
  const backup = await check(saved, pass);
  await run("SELECT setval(pg_get_serial_sequence('down', 'id'), -100); SELECT setval(pg_get_serial_sequence('lost', 'id'), 100)");
  await restore(backup);
  // gap carries on from where the backup had it, past its rows, and so does down, which counts down.
  assert.deepEqual([await nextId("ahead"), await nextId("edge"), await nextId("gap"), await nextId("down"), await nextId("lost")], [11, 6, 7, -4, 4]);
  assert.deepEqual(await rows("INSERT INTO twice DEFAULT VALUES RETURNING a, b"), [{ a: 4, b: 10 }]);
});

test("a restore whose secrets cannot be kept changes nothing", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text); INSERT INTO notes VALUES ('saved')");
  const backup = await check(await save(tempDir(t)));
  await run("UPDATE notes SET note = 'changed'");
  const was = await fingerprint("notes");
  const marker = await readRestoreMarker(socketDir());
  const boom = new Error("The disk is full.");
  let removed = 0;
  await assert.rejects(
    loadBackup({
      socketDir: socketDir(),
      backup,
      appVersion,
      writePending: () => {
        throw boom;
      },
      removePending: () => {
        removed += 1;
      },
    }),
    (error) => error === boom,
  );
  // The secrets may be half written, so they are taken back too.
  assert.equal(removed, 1);
  assert.deepEqual(await fingerprint("notes"), was);
  assert.equal(await readRestoreMarker(socketDir()), marker);
});

test("a restore that fails as it commits changes nothing and takes its secrets back", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text); INSERT INTO notes VALUES ('saved')");
  const backup = await check(await save(tempDir(t)));
  // A rule that says no only as the transaction commits, which a restore
  // cannot skip. By then the secrets have been handed over.
  await run(`
    CREATE FUNCTION refuse_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Refused as the transaction commits.' USING ERRCODE = 'check_violation';
      END
    $$;
    CREATE CONSTRAINT TRIGGER notes_at_commit AFTER INSERT ON notes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_at_commit();
    ALTER TABLE notes ENABLE ALWAYS TRIGGER notes_at_commit;
    UPDATE notes SET note = 'changed';
  `);
  const was = await fingerprint("notes");
  const marker = await readRestoreMarker(socketDir());
  const kept: Kept = { pending: [], removed: 0 };
  await assert.rejects(restore(backup, kept), backupError(DOES_NOT_FIT, { code: "23514" }));
  assert.equal(kept.pending.length, 1);
  assert.equal(kept.removed, 1);
  assert.deepEqual(await fingerprint("notes"), was);
  assert.equal(await readRestoreMarker(socketDir()), marker);
});

test("the database remembers which restore went in last", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text)");
  const db = quoteIdent(DB_NAME);
  // A comment that a restore did not write is no restore's mark.
  await run(`COMMENT ON DATABASE ${db} IS 'Something else wrote this'`);
  assert.equal(await readRestoreMarker(socketDir()), null);
  await run(`COMMENT ON DATABASE ${db} IS NULL`);
  assert.equal(await readRestoreMarker(socketDir()), null);

  const backup = await check(await save(tempDir(t)));
  const first: Kept = { pending: [], removed: 0 };
  const second: Kept = { pending: [], removed: 0 };
  await restore(backup, first);
  await restore(backup, second);
  assert.equal(first.pending.length, 1);
  assert.equal(second.pending.length, 1);
  assert.notEqual(first.pending[0].id, second.pending[0].id);
  assert.equal(await readRestoreMarker(socketDir()), second.pending[0].id);
});

test("a start with no restore waiting changes nothing", async (t) => {
  const calls: string[] = [];
  const found = await finishPendingRestore({
    // No database: with nothing waiting, it is never asked.
    socketDir: path.join(tempDir(t), "no-database"),
    pending: pendingFile({ status: "missing" }, calls),
    apply: async () => {
      calls.push("apply");
    },
  });
  assert.equal(found, "none");
  assert.deepEqual(calls, []);
});

test("the next start finishes a restore that went in, then removes its file", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text)");
  const saved = await save(tempDir(t));
  const kept: Kept = { pending: [], removed: 0 };
  await restore(await check(saved), kept);
  assert.equal(kept.pending.length, 1);
  const [pending] = kept.pending;
  const token = saved.secrets.githubToken;
  assert.ok(token !== null);
  assert.ok(!logSecrets().includes(saved.secrets.appEncryptionKey));
  assert.ok(!logSecrets().includes(token));

  const calls: string[] = [];
  const applied: PendingRestore[] = [];
  const found = await finishPendingRestore({
    socketDir: socketDir(),
    pending: pendingFile(holding(pending), calls),
    apply: async (values) => {
      calls.push("apply");
      applied.push(values);
    },
  });
  assert.equal(found, "finished");
  // The file goes only once the backup's secrets and settings are in place.
  assert.deepEqual(calls, ["apply", "remove"]);
  assert.deepEqual(applied, [{ id: pending.id, secrets: saved.secrets, config }]);
  // In use from now on, so the log hides them.
  assert.ok(logSecrets().includes(saved.secrets.appEncryptionKey));
  assert.ok(logSecrets().includes(token));
});

test("the next start throws away a restore that did not go in", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text)");
  const kept: Kept = { pending: [], removed: 0 };
  await restore(await check(await save(tempDir(t))), kept);
  const [pending] = kept.pending;
  const calls: string[] = [];
  const finish = (waiting: PendingRestore) =>
    finishPendingRestore({
      socketDir: socketDir(),
      pending: pendingFile(holding(waiting), calls),
      apply: async () => {
        calls.push("apply");
      },
    });
  // The database carries another restore's mark, as when this one stopped before it went in.
  assert.equal(await finish({ ...pending, id: newRestoreId() }), "not-in");
  // Or no mark at all.
  await run(`COMMENT ON DATABASE ${quoteIdent(DB_NAME)} IS NULL`);
  assert.equal(await finish(pending), "not-in");
  assert.deepEqual(calls, ["remove", "remove"]);
});

test("a restore that cannot be finished waits for the next start", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text)");
  const kept: Kept = { pending: [], removed: 0 };
  await restore(await check(await save(tempDir(t))), kept);
  const calls: string[] = [];
  const problem = new Error("There is no space left on the disk.");
  await assert.rejects(
    finishPendingRestore({
      socketDir: socketDir(),
      pending: pendingFile(holding(kept.pending[0]), calls),
      apply: async () => {
        throw problem;
      },
    }),
    (error) => error === problem,
  );
  assert.deepEqual(calls, []);
});

test("a restore locked with a keyring that did not open stops the start until it opens", async (t) => {
  const calls: string[] = [];
  await assert.rejects(
    finishPendingRestore({
      socketDir: path.join(tempDir(t), "no-database"),
      pending: pendingFile({ status: "locked", message: "restore-pending.json is locked with a login keyring that did not open." }, calls),
      apply: async () => {
        calls.push("apply");
      },
    }),
    (error) => {
      assert.ok(error instanceof StartupError, `Expected a StartupError, but got ${String(error)}.`);
      assert.equal(error.title, FINISH_TITLE);
      assert.equal(error.message, PENDING_LOCKED);
      return true;
    },
  );
  // Kept, since the rows may already be the backup's and its keys are the only ones that open them.
  assert.deepEqual(calls, []);
});

test("a damaged restore file is thrown away, even when it cannot be removed", async (t) => {
  const socket = path.join(tempDir(t), "no-database");
  const damaged: LoadResult<PendingRestore> = { status: "damaged", message: "restore-pending.json is not in the form Schema Studio writes." };
  const apply = async () => {
    assert.fail("A damaged restore file holds nothing to put in place.");
  };
  const calls: string[] = [];
  assert.equal(await finishPendingRestore({ socketDir: socket, pending: pendingFile(damaged, calls), apply }), "none");
  assert.deepEqual(calls, ["remove"]);
  // Only logged, since the next start finds it again and tries again.
  const stuck: PendingRestoreStore = {
    load: () => damaged,
    remove: () => {
      throw new Error("The file is in use.");
    },
  };
  assert.equal(await finishPendingRestore({ socketDir: socket, pending: stuck, apply }), "none");
});

test("a backup with a table or column this database does not have is refused when it is checked", async (t) => {
  if (skipped(t)) return;
  const dir = tempDir(t);
  await reset();
  await run("CREATE TABLE t (keep text, gone text); INSERT INTO t VALUES ('kept', 'dropped')");
  const withColumn = await save(dir);
  await run("ALTER TABLE t DROP COLUMN gone");
  await assert.rejects(check(withColumn), backupError(DOES_NOT_FIT, { cause: "The t table of this database has no gone column." }));

  await reset();
  await run("CREATE TABLE kept (v text); CREATE TABLE t (v text)");
  const withTable = await save(dir);
  await run("DROP TABLE t");
  await assert.rejects(check(withTable), backupError(DOES_NOT_FIT, { cause: "This database has no t table." }));
});

test("a column added since the backup is filled in by its default, or the backup is refused if it has none", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE t (v text); INSERT INTO t VALUES ('a'); CREATE TABLE empty_one (v text)");
  const saved = await save(tempDir(t));
  // Columns every row needs, with no default to fill them in. The backup has
  // no rows for empty_one, so nothing needs filling in there.
  await run(`
    ALTER TABLE t ADD COLUMN req int NOT NULL DEFAULT 0;
    ALTER TABLE t ALTER COLUMN req DROP DEFAULT;
    ALTER TABLE empty_one ADD COLUMN req int NOT NULL;
  `);
  await assert.rejects(check(saved), backupError(DOES_NOT_FIT, { cause: "The backup's t table has no req column, which every row needs here." }));

  // Columns the backup has no values for, each filled in its own way: by its default, left empty, or numbered.
  await run(`
    ALTER TABLE t DROP COLUMN req;
    ALTER TABLE t ADD COLUMN added text NOT NULL DEFAULT 'filled in';
    ALTER TABLE t ADD COLUMN maybe text;
    ALTER TABLE t ADD COLUMN n int GENERATED ALWAYS AS IDENTITY;
    UPDATE t SET v = 'b', added = 'changed';
  `);
  await restore(await check(saved));
  assert.deepEqual(await rows("SELECT v, added, maybe, n FROM t"), [{ v: "a", added: "filled in", maybe: null, n: 1 }]);
  assert.deepEqual(await rows("SELECT count(*)::int AS n FROM empty_one"), [{ n: 0 }]);
});

test("rows that no longer fit their columns or rules are refused with nothing changed", async (t) => {
  if (skipped(t)) return;
  const dir = tempDir(t);
  const cases = [
    { values: "(1), (1)", add: "ALTER TABLE t ADD CONSTRAINT t_rule UNIQUE (v)", code: "23505" },
    { values: "(-1)", add: "ALTER TABLE t ADD CONSTRAINT t_rule CHECK (v > 0)", code: "23514" },
    { values: "(NULL)", add: "ALTER TABLE t ALTER COLUMN v SET NOT NULL", code: "23502" },
  ];
  for (const { values, add, code } of cases) {
    await reset();
    await run(`CREATE TABLE t (v int); INSERT INTO t VALUES ${values}`);
    const saved = await save(dir);
    await run(`DELETE FROM t; INSERT INTO t VALUES (2); ${add}`);
    await refused(await check(saved), DOES_NOT_FIT, ["t"], { code });
  }

  // A value that no longer reads as its column's type.
  await reset();
  await run("CREATE TABLE t (v text); INSERT INTO t VALUES ('abc')");
  const saved = await save(dir);
  await run("TRUNCATE t; ALTER TABLE t ALTER COLUMN v TYPE integer USING v::integer; INSERT INTO t VALUES (7)");
  await refused(await check(saved), DOES_NOT_FIT, ["t"], { code: "22P02" });

  // A value too long for its column now, which is refused rather than cut short to fit.
  await reset();
  await run("CREATE TABLE t (v varchar(30)); INSERT INTO t VALUES (repeat('x', 25))");
  const long = await save(dir);
  await run("TRUNCATE t; ALTER TABLE t ALTER COLUMN v TYPE varchar(20); INSERT INTO t VALUES ('short')");
  await refused(await check(long), DOES_NOT_FIT, ["t"], { code: "22001" });
});

test("rows that break a rule allowed to wait until the end are refused", async (t) => {
  if (skipped(t)) return;
  const dir = tempDir(t);
  const cases = [
    { add: "ALTER TABLE t ADD CONSTRAINT t_rule UNIQUE (v) DEFERRABLE INITIALLY DEFERRED", code: "23505" },
    { add: "ALTER TABLE t ADD CONSTRAINT t_rule EXCLUDE USING btree (v WITH =) DEFERRABLE", code: "23P01" },
    { add: "ALTER TABLE t ADD CONSTRAINT t_rule PRIMARY KEY (v) DEFERRABLE INITIALLY IMMEDIATE", code: "23505" },
  ];
  for (const { add, code } of cases) {
    await reset();
    await run("CREATE TABLE t (v int); INSERT INTO t VALUES (1), (1), (2)");
    const saved = await save(dir);
    await run(`DELETE FROM t WHERE v = 1; ${add}`);
    await refused(await check(saved), DOES_NOT_FIT, ["t"], { code });
  }

  // The same rule on a table in parts, where each part has an index of its own.
  await reset();
  await run(`
    CREATE TABLE t (at int, v int) PARTITION BY RANGE (at);
    CREATE TABLE t_low PARTITION OF t FOR VALUES FROM (0) TO (10);
    CREATE TABLE t_high PARTITION OF t FOR VALUES FROM (10) TO (20);
    INSERT INTO t VALUES (1, 1), (1, 1), (11, 1);
  `);
  const saved = await save(dir);
  await run("DELETE FROM t WHERE at = 1; ALTER TABLE t ADD CONSTRAINT t_rule UNIQUE (at, v) DEFERRABLE");
  await refused(await check(saved), DOES_NOT_FIT, ["t"], { code: "23505" });
});

test("rows that keep the rules allowed to wait until the end come back, and other schemas are left alone", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run(`
    CREATE TABLE t (v int UNIQUE DEFERRABLE INITIALLY DEFERRED, w int, EXCLUDE USING btree (w WITH =) DEFERRABLE, k int, PRIMARY KEY (k) DEFERRABLE);
    INSERT INTO t VALUES (1, 1, 1), (2, 2, 2), (NULL, NULL, 3), (NULL, NULL, 4);
    CREATE TABLE p (at int, v int, UNIQUE (at, v) DEFERRABLE) PARTITION BY RANGE (at);
    CREATE TABLE p_low PARTITION OF p FOR VALUES FROM (0) TO (10);
    CREATE TABLE p_high PARTITION OF p FOR VALUES FROM (10) TO (20);
    INSERT INTO p VALUES (1, 1), (11, 1), (1, NULL), (1, NULL);
  `);
  // A table outside the app's schema whose rows already break its rule: a restore neither checks nor touches it.
  await run(`
    CREATE SCHEMA other;
    CREATE TABLE other.elsewhere (v int UNIQUE DEFERRABLE);
    BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO other.elsewhere VALUES (1), (1);
    COMMIT;
  `);
  const was = await fingerprint("t", "p");
  const saved = await save(tempDir(t));
  await run("DELETE FROM t; DELETE FROM p");
  await restore(await check(saved));
  assert.deepEqual(await fingerprint("t", "p"), was);
  assert.deepEqual(await rows("SELECT count(*)::int AS n FROM other.elsewhere"), [{ n: 2 }]);
});

test("a backup file that changed after it was checked is not restored", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text); INSERT INTO notes VALUES ('first')");
  const dir = tempDir(t);
  const saved = await save(dir);
  const backup = await check(saved);
  const records = await readRecords(saved.file, saved.pass);
  await run("UPDATE notes SET note = 'second'");

  // Another backup saved in its place, which starts differently.
  await save(dir);
  await refused(backup, CHANGED, ["notes"]);
  // The same start, with other contents after it.
  const manifest = JSON.parse(records[0]) as BackupManifest;
  craft(saved.file, backup, [JSON.stringify({ ...manifest, createdAt: "2000-01-01T00:00:00.000Z" }), ...records.slice(1)]);
  await refused(backup, CHANGED, ["notes"]);
  // And the very contents that were checked go in.
  craft(saved.file, backup, records);
  await restore(backup);
  assert.deepEqual(await rows("SELECT note FROM notes"), [{ note: "first" }]);
});

test("a file that is not a backup, is damaged, is newer or needs another passphrase is refused when it is checked", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text); INSERT INTO notes VALUES ('kept')");
  const dir = tempDir(t);
  const saved = await save(dir);
  const data = fs.readFileSync(saved.file);
  /** The saved backup, but with the file at `name` in its place. */
  const other = (name: string): Saved => ({ ...saved, file: path.join(dir, name) });

  await assert.rejects(check(saved, `${saved.pass}x`), backupError(WRONG_PASSPHRASE));
  fs.writeFileSync(other("empty").file, "");
  await assert.rejects(check(other("empty")), backupError(NOT_A_BACKUP));
  fs.writeFileSync(other("notes.txt").file, "Just some notes, not a backup.");
  await assert.rejects(check(other("notes.txt")), backupError(NOT_A_BACKUP));
  fs.mkdirSync(other("folder").file);
  await assert.rejects(check(other("folder")), backupError(NOT_A_BACKUP));
  await assert.rejects(check(other("missing")), backupError("Schema Studio cannot find that file anymore. Choose it again."));
  fs.writeFileSync(other("cut").file, data.subarray(0, data.length - 10));
  await assert.rejects(check(other("cut")), backupError(DAMAGED));
  fs.writeFileSync(other("header-only").file, data.subarray(0, HEADER_BYTES));
  await assert.rejects(check(other("header-only")), backupError(DAMAGED));
  // Saved by a later version of the app than the one checking it.
  await assert.rejects(check(await save(dir, "2.0.0")), backupError(NEWER));
});

test("a database that is still being set up is neither saved nor restored", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text); INSERT INTO notes VALUES ('kept')");
  const dir = tempDir(t);
  const saved = await save(dir);
  const backup = await check(saved);
  // As the database is before the app has made its tables.
  await reset();
  await assert.rejects(
    saveBackup({
      socketDir: socketDir(),
      file: path.join(dir, "fresh.ssbackup"),
      passphrase: passphrase(),
      appVersion,
      secrets: secrets(),
      config,
      cost: MIN_COST,
    }),
    backupError(STILL_SETTING_UP),
  );
  assert.deepEqual(fs.readdirSync(dir), ["backup.ssbackup"]);
  await assert.rejects(check(saved), backupError(STILL_SETTING_UP));
  const kept: Kept = { pending: [], removed: 0 };
  await assert.rejects(restore(backup, kept), backupError(STILL_SETTING_UP));
  assert.deepEqual(kept, { pending: [], removed: 0 });
});

test("rows that are not what the backup promised are refused", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text); INSERT INTO notes VALUES ('kept')");
  const saved = await save(tempDir(t));
  const [manifest] = await readRecords(saved.file, saved.pass);
  const pass = passphrase();
  const lock = await newBackupKey(pass, { cost: MIN_COST });
  // Two rows in a record where the backup promised one: the file reads as whole, but the rows do not go in.
  craft(saved.file, lock, [manifest, '{"note":"a"},{"note":"b"}']);
  await refused(await check(saved, pass), DAMAGED, ["notes"]);
  // A row that is not JSON at all.
  craft(saved.file, lock, [manifest, "{oops}"]);
  await refused(await check(saved, pass), DOES_NOT_FIT, ["notes"], { code: "22P02" });
});

test("partitioned tables, inherited tables and tables without columns come back as they were", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run(`
    CREATE TABLE events (at date NOT NULL, what text) PARTITION BY RANGE (at);
    CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
    CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
    INSERT INTO events VALUES ('2025-06-01', 'old'), ('2026-02-01', 'new'), ('2026-03-01', 'newer');
    CREATE TABLE base (v text);
    CREATE TABLE derived (extra int) INHERITS (base);
    INSERT INTO base VALUES ('in base');
    INSERT INTO derived VALUES ('in derived', 1);
    CREATE TABLE "empty" ();
    INSERT INTO "empty" DEFAULT VALUES;
  `);
  const tables = ["events", "events_2025", "events_2026", "base", "derived"];
  const was = await fingerprint(...tables);
  const backup = await check(await save(tempDir(t)));
  // A partitioned table is saved whole, with the rows of its parts. A table
  // that inherits is saved apart from the one it inherits from, and a table
  // without columns not at all.
  assert.deepEqual(
    backup.manifest.tables.map((table) => [table.name, table.rows]),
    [
      ["base", 1],
      ["derived", 1],
      ["events", 3],
    ],
  );
  await run("DELETE FROM events; DELETE FROM base; INSERT INTO derived VALUES ('new', 2)");
  await restore(backup);
  assert.deepEqual(await fingerprint(...tables), was);
  assert.deepEqual(await rows(`SELECT count(*)::int AS n FROM "empty"`), [{ n: 0 }]);
});

test("a backup that cannot be saved says why and leaves nothing behind", async (t) => {
  if (skipped(t)) return;
  await reset();
  await run("CREATE TABLE notes (note text); INSERT INTO notes VALUES ('kept')");
  const dir = tempDir(t);
  const options = { socketDir: socketDir(), passphrase: passphrase(), appVersion, secrets: secrets(), config, cost: MIN_COST };
  await assert.rejects(
    saveBackup({ ...options, file: path.join(dir, "gone", "backup.ssbackup") }),
    backupError("That folder is not there anymore. Choose another folder, then try again."),
  );
  fs.mkdirSync(path.join(dir, "taken"));
  await assert.rejects(
    saveBackup({ ...options, file: path.join(dir, "taken") }),
    backupError("There is already a folder with that name. Choose another name, then try again."),
  );
  // Not even the hidden file a backup is written to first.
  assert.deepEqual(fs.readdirSync(dir), ["taken"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "taken")), []);
});

test("a passphrase that is too short is refused before anything is saved", async (t) => {
  const dir = tempDir(t);
  const message = passphraseProblem("short");
  assert.ok(message !== null);
  await assert.rejects(
    saveBackup({
      socketDir: path.join(dir, "no-database"),
      file: path.join(dir, "backup.ssbackup"),
      passphrase: "short",
      appVersion,
      secrets: secrets(),
      config,
    }),
    backupError(message),
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("big tables and big rows come back whole", async (t) => {
  if (skipped(t)) return;
  await reset();
  // More rows than go in at once, and rows too big for more than two to go in together.
  await run(`
    CREATE TABLE bulk (i int, filler text);
    INSERT INTO bulk SELECT i, repeat(md5(i::text), 20) FROM generate_series(1, 1234) AS i;
    CREATE TABLE huge (i int, filler text);
    INSERT INTO huge SELECT i, repeat('x', 3000000) || i FROM generate_series(1, 3) AS i;
  `);
  const was = [await digest("bulk"), await digest("huge")];
  const backup = await check(await save(tempDir(t)));
  await run("DELETE FROM bulk WHERE i % 2 = 0; UPDATE huge SET filler = 'small'");
  await restore(backup);
  assert.deepEqual([await digest("bulk"), await digest("huge")], was);
});
