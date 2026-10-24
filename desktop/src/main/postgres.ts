/**
 * Runs the app's own PostgreSQL 17: sets up a new database the first time,
 * starts it each time the app opens, and stops it when the app quits.
 *
 * The programs come with the app (scripts/fetch-postgres.mjs fetches them and
 * scripts/after-pack.cjs puts them in the install's resources folder), so
 * nothing has to be installed, and a PostgreSQL the person already has is
 * never touched. The database lives in ~/.local/share/schema-studio/postgres
 * and has no network port at all: it answers only on a socket file, in a
 * folder only this person can open (see src/core/postgres-files.ts).
 *
 * The person's data is never deleted or changed behind their back. A data
 * folder that is incomplete, or was made by another version of PostgreSQL,
 * stops the app with a message that says what to do, rather than being
 * replaced. The one thing removed without asking is data.new, the half-made
 * folder of a first setup that was cut off, which never held anything.
 *
 * PostgreSQL leaves its lock files behind when it is killed (a crash, a power
 * cut), and refuses to start while one names a process that is running.
 * Process numbers get reused, so a leftover lock is looked at first: when its
 * process is gone, PostgreSQL clears it itself; when the number now belongs
 * to some other program, the lock is stale and is removed; and when it is
 * this database's own PostgreSQL, left running by an app that crashed, that
 * is stopped properly before a new one starts.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

import { writeFileAtomic } from "../core/atomic-file";
import { displayPath, type AppPaths } from "../core/paths";
import {
  collationNeedsRefresh,
  DB_NAME,
  DB_USER,
  initdbArgs,
  initdbFallbackArgs,
  parsePgVersion,
  parsePostmasterPid,
  pgHbaConf,
  pgIdentConf,
  PG_MAJOR,
  PG_PORT,
  postgresArgs,
} from "../core/postgres-files";
import { ensurePrivateDir } from "../core/private-dir";
import { redact } from "../core/redact";
import { SOCKET_FILE, socketDirCandidates } from "../core/socket-dir";
import { logError, logFilePaths, logInfo, logWarn, openPostgresLogFd } from "./log";
import { StartupError } from "./startup-error";

export type RunningPostgres = {
  /** The folder that holds the database's socket. */
  socketDir: string;
  /** Stops the database, giving it time to finish writing first. */
  stop(): Promise<void>;
  /** Runs if the database stops while the app is still using it. */
  onUnexpectedExit(listener: (description: string) => void): void;
};

export type StartPostgresOptions = {
  /** PostgreSQL's bin, lib and share folders (AppFiles.postgresDir). */
  installDir: string;
  paths: AppPaths;
  /** Aborted when the app quits while the database is still starting. */
  signal: AbortSignal;
};

const TITLE = "The database could not start";
const DAMAGED_INSTALL =
  "The database program that comes with Schema Studio is missing or damaged. Reinstall Schema Studio.";

/** Setting up takes a few seconds. This only stops one that hangs. */
const INITDB_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 200;
const POLL_MS = 100;
/**
 * The ways of stopping PostgreSQL, gentlest first, and how long each one
 * gets. SIGINT is its "fast" shutdown: it closes the connections and writes
 * everything to disk. SIGQUIT is "immediate": it stops at once, and the next
 * start replays the database's journal, so nothing saved is lost. SIGKILL is
 * for a PostgreSQL that answers neither.
 */
const STOP_STEPS: [NodeJS.Signals, number][] = [
  ["SIGINT", 10_000],
  ["SIGQUIT", 5_000],
  ["SIGKILL", 5_000],
];
/** The most of postgres.log read back to explain a failed start. */
const LOG_READ_BYTES = 64 * 1024;

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };

function describeExit(info: ExitInfo): string {
  return info.signal !== null ? `stopped by ${info.signal}` : `exit status ${info.code}`;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A program that could not be started at all means the install is broken. */
function startFailure(error: Error): Error {
  const code = errorCode(error);
  // ENOEXEC: a program built for another kind of processor.
  return code === "ENOENT" || code === "EACCES" || code === "ENOEXEC"
    ? new StartupError(TITLE, DAMAGED_INSTALL, error)
    : error;
}

/** A running program, and what became of it. */
class Watched {
  readonly child: ChildProcess;
  exit: ExitInfo | null = null;
  /** Why the program could not be started, when it could not. */
  error: Error | null = null;
  private readonly waiters: (() => void)[] = [];

  constructor(child: ChildProcess) {
    this.child = child;
    child.once("exit", (code, signal) => {
      this.exit = { code, signal };
      this.wake();
    });
    // Without a listener, a failure to start the program would be an
    // uncaught error in the main process. A program that never started has
    // no process number.
    child.on("error", (error) => {
      if (child.pid === undefined && this.error === null) {
        this.error = error;
        this.wake();
      } else {
        logWarn("Could not signal the database.", error);
      }
    });
  }

  get done(): boolean {
    return this.exit !== null || this.error !== null;
  }

  /** Runs `listener` once the program has ended, or at once if it already has. */
  onDone(listener: () => void): void {
    if (this.done) listener();
    else this.waiters.push(listener);
  }

  /** Waits up to `ms` for the program to end, and says whether it did. */
  waitUntilDone(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.done), ms);
      this.onDone(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

async function stopProgram(program: Watched): Promise<void> {
  for (const [signal, ms] of STOP_STEPS) {
    if (program.done) return;
    program.child.kill(signal);
    if (await program.waitUntilDone(ms)) return;
  }
  logError("The database did not stop, even when killed.");
}

type RunOptions = { env: NodeJS.ProcessEnv; logFd: number | null; cwd: string; timeoutMs: number; signal: AbortSignal };

/** Runs a program to the end, with its output going to postgres.log. */
function runProgram(file: string, args: string[], options: RunOptions): Promise<ExitInfo> {
  return new Promise((resolve, reject) => {
    const output = options.logFd ?? "ignore";
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", output, output],
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      signal: options.signal,
    });
    child.on("error", (error) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else if (child.pid === undefined) reject(startFailure(error));
      else logWarn(`Could not signal ${path.basename(file)}.`, error);
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * The environment PostgreSQL's programs run with: only what they need. None
 * of the person's own PG* settings (a PGHOST, say) get through, and messages
 * come out in plain English (LC_ALL=C), so the app can read them.
 */
function programEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C" };
  for (const name of ["HOME", "TZ"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function pathExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** The first folder for the socket that can be made private to this person. */
function chooseSocketDir(paths: AppPaths): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  let runtimeDirExists = false;
  if (runtimeDir) {
    try {
      runtimeDirExists = fs.statSync(runtimeDir).isDirectory();
    } catch {
      // Not there, as in a session started without a login manager.
    }
  }
  const candidates = socketDirCandidates({
    platform: process.platform,
    runtimeDir,
    runtimeDirExists,
    dataDir: paths.data,
    uid: process.getuid?.() ?? 0,
  });
  for (const dir of candidates) {
    try {
      ensurePrivateDir(dir);
      return dir;
    } catch (error) {
      logWarn(`Could not use ${dir} for the database's socket.`, error);
    }
  }
  throw new StartupError(TITLE, "Schema Studio could not find a private folder for the database to use. Open the logs for details.");
}

/** Makes a new, empty database folder, in data.new first so a cut-off setup never looks finished. */
async function setUpDataDir(initdbProgram: string, dataDir: string, run: Omit<RunOptions, "cwd" | "timeoutMs">): Promise<void> {
  const parent = path.dirname(dataDir);
  const dataNew = path.join(parent, "data.new");
  const initdb = (args: string[]) => runProgram(initdbProgram, args, { ...run, cwd: parent, timeoutMs: INITDB_TIMEOUT_MS });

  fs.rmSync(dataNew, { recursive: true, force: true });
  logInfo("Setting up a new database.");
  let result = await initdb(initdbArgs(dataNew));
  if (result.code !== 0) {
    logWarn(
      `Setting up the database with ICU's text sorting failed (${describeExit(result)}), so it is being set up with PostgreSQL's built-in sorting instead.`,
    );
    fs.rmSync(dataNew, { recursive: true, force: true });
    result = await initdb(initdbFallbackArgs(dataNew));
  }
  if (result.code !== 0) {
    logError(`Setting up the database failed again (${describeExit(result)}).`);
    fs.rmSync(dataNew, { recursive: true, force: true });
    throw new StartupError(TITLE, "Schema Studio could not set up its database. Open the logs for details.");
  }
  fs.renameSync(dataNew, dataDir);
  logInfo("The new database is set up.");
}

/** Checks that an existing data folder is a PostgreSQL 17 database, without changing anything in it. */
function checkDataDir(dataDir: string): void {
  ensurePrivateDir(dataDir);
  const shown = displayPath(dataDir, os.homedir());
  let version: number | null = null;
  try {
    version = parsePgVersion(fs.readFileSync(path.join(dataDir, "PG_VERSION"), "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") logWarn(`Could not read ${path.join(dataDir, "PG_VERSION")}.`, error);
  }
  const moveIt = "Move it somewhere else to start with a new, empty database, then press Try again.";
  if (version === null) {
    throw new StartupError(
      "The database folder is incomplete",
      `The database folder (${shown}) is there but is not a complete database. Schema Studio will not change it. ${moveIt}`,
    );
  }
  if (version > PG_MAJOR) {
    throw new StartupError(
      "The database is from a newer version",
      `The database folder (${shown}) was made by a newer version of Schema Studio, which uses PostgreSQL ${version}. This version uses PostgreSQL ${PG_MAJOR} and cannot open it. Install the newer version again, or move the folder somewhere else to start with a new, empty database, then press Try again.`,
    );
  }
  if (version < PG_MAJOR) {
    throw new StartupError(
      "The database is from an older version",
      `The database folder (${shown}) was made by PostgreSQL ${version}, and this version of Schema Studio uses PostgreSQL ${PG_MAJOR}, which cannot open it. Schema Studio will not change it. ${moveIt}`,
    );
  }
}

/** Writes the two files that say who may connect. They are written fresh on every start. */
function writeAuthFiles(dataDir: string): void {
  let username: string;
  try {
    username = os.userInfo().username;
  } catch (error) {
    throw new StartupError(
      TITLE,
      "Schema Studio could not find out which user it is running as, which the database needs to know. Open the logs for details.",
      error,
    );
  }
  let identConf: string;
  try {
    identConf = pgIdentConf(username);
  } catch (error) {
    throw new StartupError(TITLE, error instanceof Error ? error.message : String(error), error);
  }
  writeFileAtomic(path.join(dataDir, "pg_hba.conf"), pgHbaConf());
  writeFileAtomic(path.join(dataDir, "pg_ident.conf"), identConf);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** True when process `pid` is a PostgreSQL running on `dataDir`. */
function isThisDatabase(pid: number, dataDir: string): boolean {
  try {
    if (process.platform === "linux") {
      if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "postgres") return false;
      // PostgreSQL works from inside its data folder.
      try {
        if (fs.realpathSync(`/proc/${pid}/cwd`) === fs.realpathSync(dataDir)) return true;
      } catch {
        // Not readable: the command line below decides.
      }
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(dataDir);
    }
    const ps = (field: string) =>
      execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    return path.basename(ps("comm")) === "postgres" && ps("command").includes(dataDir);
  } catch {
    return false;
  }
}

/** Stops a PostgreSQL left running by an earlier run, which this run did not start. */
async function stopLeftover(pid: number): Promise<void> {
  for (const [signal, ms] of STOP_STEPS) {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await delay(POLL_MS);
      if (!isRunning(pid)) return;
    }
  }
  throw new StartupError(
    TITLE,
    "The database from an earlier run of Schema Studio is still running and did not stop. Restart the computer, then open Schema Studio again.",
  );
}

function removeLock(lockFile: string, why: string): void {
  logWarn(`Removing ${lockFile}, a lock file left by an earlier run, because ${why}.`);
  try {
    fs.rmSync(lockFile, { force: true });
  } catch (error) {
    logWarn(`Could not remove ${lockFile}.`, error);
  }
}

/** Deals with a lock file left by a PostgreSQL that did not stop properly (see the top of this file). */
async function clearStaleLock(lockFile: string, dataDir: string): Promise<void> {
  let text: string;
  try {
    text = fs.readFileSync(lockFile, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const lock = parsePostmasterPid(text);
  if (lock === null) {
    // Cut off while it was being written, so no PostgreSQL ever ran with it.
    removeLock(lockFile, "it is incomplete");
    return;
  }
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    // ESRCH: no process has that number now, and PostgreSQL clears the file itself.
    if (errorCode(error) !== "EPERM") return;
    removeLock(lockFile, `process ${lock.pid} belongs to another user, so it is not this database`);
    return;
  }
  if (isThisDatabase(lock.pid, dataDir)) {
    logWarn(`The database from an earlier run is still running (process ${lock.pid}), so it is being stopped first.`);
    await stopLeftover(lock.pid);
    return;
  }
  removeLock(lockFile, `process ${lock.pid} is another program now`);
}

/** The size of postgres.log, so a failed start can read back only what it wrote. */
function logSize(logFd: number | null): number {
  if (logFd === null) return 0;
  try {
    return fs.fstatSync(logFd).size;
  } catch {
    return 0;
  }
}

/** The last error PostgreSQL wrote to postgres.log after `offset`, without its time and level. */
function lastComplaint(offset: number): string | null {
  const file = logFilePaths()?.postgres;
  if (file === undefined) return null;
  let text: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.min(size, Math.max(offset, size - LOG_READ_BYTES));
      const buffer = Buffer.alloc(size - start);
      const read = fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const complaints = text.split("\n").filter((line) => /\b(?:FATAL|PANIC|ERROR):/.test(line));
  const last = complaints[complaints.length - 1];
  if (last === undefined) return null;
  const said = last.replace(/^.*?\b(?:FATAL|PANIC|ERROR):\s*/, "").trim();
  // Shown on screen, so the home folder becomes ~, as everywhere else.
  return said === "" ? null : redact(said, { secrets: [], home: os.homedir() }).slice(0, 300);
}

/** Runs `work` with a connection to `database` over the socket in `socketDir`, and closes the connection afterwards. */
export async function withClient<T>(socketDir: string, database: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: socketDir,
    port: PG_PORT,
    user: DB_USER,
    database,
    ssl: false,
    connectionTimeoutMillis: 5000,
  });
  // A connection that drops is reported as an "error" event, which would
  // otherwise be an uncaught error in the main process.
  client.on("error", (error) => logWarn("The connection to the database dropped.", error));
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function canConnect(socketDir: string): Promise<boolean> {
  try {
    await withClient(socketDir, "postgres", (client) => client.query("SELECT 1"));
    return true;
  } catch {
    // Not up yet, or still replaying its journal ("the database system is starting up").
    return false;
  }
}

async function waitUntilReady(program: Watched, socketDir: string, signal: AbortSignal, logOffset: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (program.error !== null) throw startFailure(program.error);
    if (program.exit !== null) {
      logError(`The database stopped while starting (${describeExit(program.exit)}).`);
      const said = lastComplaint(logOffset);
      throw new StartupError(
        TITLE,
        said === null
          ? "The database stopped while starting, so Schema Studio cannot open. Open the logs for details."
          : `The database stopped while starting, so Schema Studio cannot open. The last thing it said was: ${said}`,
      );
    }
    signal.throwIfAborted();
    if (await canConnect(socketDir)) return;
    if (Date.now() >= deadline) {
      throw new StartupError(TITLE, "The database did not finish starting within 30 seconds. Open the logs for details.");
    }
    await delay(READY_POLL_MS);
  }
}

/** Makes the database the web app's tables go in, the first time. */
async function ensureAppDatabase(socketDir: string): Promise<void> {
  await withClient(socketDir, "postgres", async (client) => {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB_NAME]);
    if (found.rows.length > 0) return;
    // DB_NAME is a fixed, plain name, so it needs no quoting.
    await client.query(`CREATE DATABASE ${DB_NAME}`);
    logInfo(`Made the ${DB_NAME} database.`);
  });
}

/** A name (of a database, table or column) as SQL: in double quotes, with any double quote in it doubled. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Rebuilds the indexes of any database whose text sorting rules changed
 * since they were made (see collationNeedsRefresh), and records the new
 * rules, so an update of the app never leaves an index that misses rows.
 */
async function refreshCollations(socketDir: string): Promise<void> {
  const rows = await withClient(socketDir, "postgres", async (client) => {
    const result = await client.query<{ datname: string; datcollversion: string | null; actual: string | null }>(
      "SELECT datname, datcollversion, pg_database_collation_actual_version(oid) AS actual FROM pg_database WHERE datallowconn",
    );
    return result.rows;
  });
  for (const row of rows) {
    if (!collationNeedsRefresh(row.datcollversion, row.actual)) continue;
    logWarn(
      `The text sorting rules for the ${row.datname} database changed from version ${row.datcollversion} to ${row.actual}, so its indexes are being rebuilt.`,
    );
    // REINDEX DATABASE works only on the database it is run in.
    await withClient(socketDir, row.datname, async (client) => {
      await client.query(`REINDEX DATABASE ${quoteIdent(row.datname)}`);
      await client.query(`ALTER DATABASE ${quoteIdent(row.datname)} REFRESH COLLATION VERSION`);
    });
    logInfo(`Rebuilt the indexes of the ${row.datname} database.`);
  }
}

function running(program: Watched, socketDir: string): RunningPostgres {
  let stopping = false;
  let unexpected: string | null = null;
  const listeners: ((description: string) => void)[] = [];
  program.onDone(() => {
    if (stopping) return;
    const description = program.exit !== null ? describeExit(program.exit) : "it could not be signaled";
    unexpected = description;
    logError(`The database stopped unexpectedly (${description}).`);
    for (const listener of listeners) listener(description);
  });
  return {
    socketDir,
    async stop() {
      if (stopping) return;
      stopping = true;
      await stopProgram(program);
      logInfo("The database stopped.");
    },
    onUnexpectedExit(listener) {
      if (unexpected !== null) listener(unexpected);
      else listeners.push(listener);
    },
  };
}

export async function startPostgres(options: StartPostgresOptions): Promise<RunningPostgres> {
  const { installDir, paths, signal } = options;
  const postgresProgram = path.join(installDir, "bin", "postgres");
  const initdbProgram = path.join(installDir, "bin", "initdb");
  for (const program of [postgresProgram, initdbProgram]) {
    try {
      fs.accessSync(program, fs.constants.X_OK);
    } catch (error) {
      throw new StartupError(TITLE, DAMAGED_INSTALL, error);
    }
  }

  ensurePrivateDir(paths.postgres);
  const socketDir = chooseSocketDir(paths);
  const dataDir = path.join(paths.postgres, "data");
  const env = programEnv();

  const logFd = openPostgresLogFd();
  try {
    if (pathExists(dataDir)) checkDataDir(dataDir);
    else await setUpDataDir(initdbProgram, dataDir, { env, logFd, signal });
    writeAuthFiles(dataDir);
    await clearStaleLock(path.join(dataDir, "postmaster.pid"), dataDir);
    await clearStaleLock(path.join(socketDir, `${SOCKET_FILE}.lock`), dataDir);
    signal.throwIfAborted();

    const logOffset = logSize(logFd);
    const output = logFd ?? "ignore";
    logInfo("Starting the database.");
    const program = new Watched(
      spawn(postgresProgram, postgresArgs(dataDir, socketDir), { cwd: dataDir, env, stdio: ["ignore", output, output] }),
    );
    try {
      await waitUntilReady(program, socketDir, signal, logOffset);
      await ensureAppDatabase(socketDir);
      await refreshCollations(socketDir);
    } catch (error) {
      await stopProgram(program);
      throw error;
    }
    logInfo("The database is ready.");
    return running(program, socketDir);
  } finally {
    // PostgreSQL has its own copy of the file by now.
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        // Already closed.
      }
    }
  }
}
