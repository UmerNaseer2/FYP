/**
 * `schema-studio --self-test`: proves that an installed copy works on this
 * computer, with no screen or person needed.
 *
 * The install tests run it on every Ubuntu version the app supports. It
 * takes the same steps as a normal start, in folders of its own that are
 * removed afterwards, and then checks the result: it makes the app's keys,
 * starts the database and the server, checks that the server refuses a
 * request that does not come from the app, loads the sign-in page, waits
 * for the server to make its tables, and turns start at sign-in on and off
 * again. It prints what happened as JSON and exits with 0 only when every
 * step worked.
 *
 * The keyring is left alone, because a test machine has none: the keys go
 * in a file only the account can read, as on a computer without a keyring.
 * Start at sign-in is turned on and off in the self-test's own folders too,
 * so what the person's own sign-in starts never changes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "pg";

import { AUTOSTART_ENTRY, autostartFileFor, isAutostartOn, setAutostart } from "../core/autostart";
import type { AppPaths } from "../core/paths";
import { metadataDatabaseUrl } from "../core/postgres-files";
import { ensurePrivateDir } from "../core/private-dir";
import { redact } from "../core/redact";
import { GATE_HEADER } from "../server/desktop-gate";
import type { AppFiles } from "./app-files";
import type { BuildInfo } from "./build-info";
import { ConfigStore } from "./config-store";
import { addLogSecret, logError, logFilePaths, logSecrets, logWarn, tailLines } from "./log";
import { startPostgres, type RunningPostgres } from "./postgres";
import type { RunningServer } from "./server";
import { openSecrets, startServerOnFreePort } from "./steps";

type StepResult = { name: string; ok: boolean; detail: string };
type Started = { postgres: RunningPostgres | null; server: RunningServer | null };

const STEP_NAMES = ["secrets", "database", "server", "gate", "page", "tables", "autostart"];
const REQUEST_TIMEOUT_MS = 15_000;
/** The server makes its tables as soon as it starts. Half a minute is ample even on a slow test machine. */
const TABLES_WAIT_MS = 30_000;
const LOG_TAIL_LINES = 80;

/** Text with the app's keys, email addresses and the home folder taken out, as in the logs. */
function plain(text: string): string {
  return redact(text, { secrets: logSecrets(), home: os.homedir() });
}

/** Runs one step and records how it went. Gives back what the step made, or undefined when it failed. */
async function attempt<T>(
  results: StepResult[],
  name: string,
  work: () => Promise<T>,
  describe: (value: T) => string,
): Promise<T | undefined> {
  try {
    const value = await work();
    results.push({ name, ok: true, detail: describe(value) });
    return value;
  } catch (error) {
    logError(`The self-test's "${name}" step failed.`, error);
    results.push({ name, ok: false, detail: plain(error instanceof Error ? error.message : String(error)) });
    return undefined;
  }
}

/** The HTTP status the server answers `url` with. */
function statusOf(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy(new Error(`The server did not answer ${new URL(url).pathname} within ${REQUEST_TIMEOUT_MS / 1000} seconds.`));
    });
    req.on("error", reject);
  });
}

/** Waits for the server to make its tables in the app's database, and gives back how many there are. */
async function waitForTables(socketDir: string): Promise<number> {
  const client = new Client({ connectionString: metadataDatabaseUrl(socketDir) });
  await client.connect();
  try {
    const deadline = Date.now() + TABLES_WAIT_MS;
    for (;;) {
      const result = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const count = result.rows[0]?.n ?? 0;
      if (count > 0) return count;
      if (Date.now() >= deadline) throw new Error(`The server made no tables within ${TABLES_WAIT_MS / 1000} seconds.`);
      await delay(500);
    }
  } finally {
    await client.end().catch((error: unknown) => logWarn("Could not close the self-test's database connection.", error));
  }
}

/**
 * Turns start at sign-in on and off again, and checks the file in between:
 * what it says, and that it has the mode every .desktop file has. Its name
 * comes from the installed package.json, so this also proves the package
 * still names the app grid entry.
 */
function checkAutostart(files: AppFiles, paths: AppPaths): void {
  const file = autostartFileFor(files.packageJson, paths.autostartDir);
  if (file === null) {
    throw new Error("The app's package.json names no app grid entry, so start at sign-in has no file to write.");
  }
  if (isAutostartOn(file)) throw new Error("Start at sign-in was already on before the self-test turned it on.");
  setAutostart(file, true);
  if (!isAutostartOn(file)) throw new Error("Start at sign-in was still off after turning it on.");
  if (fs.readFileSync(file, "utf8") !== AUTOSTART_ENTRY) {
    throw new Error("The start-at-sign-in file does not say what the app wrote.");
  }
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== 0o644) throw new Error(`The start-at-sign-in file has mode ${mode.toString(8)} instead of 644.`);
  setAutostart(file, false);
  if (fs.existsSync(file)) throw new Error("The start-at-sign-in file was still there after turning it off.");
}

async function runSteps(files: AppFiles, paths: AppPaths, build: BuildInfo, results: StepResult[], started: Started) {
  // Nothing stops the self-test part way, so this is never aborted.
  const { signal } = new AbortController();
  const gateToken = crypto.randomBytes(32).toString("base64url");
  addLogSecret(gateToken);

  const opened = await attempt(
    results,
    "secrets",
    async () => openSecrets(paths, false),
    (value) => (value.protection === "keyring" ? "kept in the keyring" : "kept in a file only this account can read"),
  );
  if (opened === undefined) return;
  for (const secret of [opened.secrets.nextauthSecret, opened.secrets.appEncryptionKey]) addLogSecret(secret);

  const postgres = await attempt(
    results,
    "database",
    () => startPostgres({ installDir: files.postgresDir, paths, signal }),
    () => "started",
  );
  if (postgres === undefined) return;
  started.postgres = postgres;

  const server = await attempt(
    results,
    "server",
    async () => {
      ensurePrivateDir(paths.config);
      return startServerOnFreePort({
        files,
        config: new ConfigStore(paths.configFile),
        socketDir: postgres.socketDir,
        buildConfig: build,
        secrets: opened.secrets,
        gateToken,
        signal,
      });
    },
    (value) => `answering on port ${value.port}`,
  );
  if (server === undefined) return;
  started.server = server;

  // The checks below do not depend on one another, so all of them run.
  const providers = `${server.origin}/api/auth/providers`;
  await attempt(
    results,
    "gate",
    async () => {
      const outsider = await statusOf(providers, {});
      if (outsider !== 403) throw new Error(`A request without the app's token got HTTP ${outsider} instead of 403.`);
      const own = await statusOf(providers, { [GATE_HEADER]: gateToken });
      if (own !== 200) throw new Error(`The app's own request got HTTP ${own} instead of 200.`);
    },
    () => "refuses requests that do not come from the app",
  );
  await attempt(
    results,
    "page",
    async () => {
      const status = await statusOf(`${server.origin}/login`, { [GATE_HEADER]: gateToken });
      if (status !== 200) throw new Error(`The sign-in page answered HTTP ${status}.`);
    },
    () => "the sign-in page loads",
  );
  await attempt(results, "tables", () => waitForTables(postgres.socketDir), (count) => `${count} tables made`);
}

async function stopAll(started: Started): Promise<void> {
  if (started.server !== null) {
    try {
      await started.server.stop();
    } catch (error) {
      logWarn("The server did not stop cleanly.", error);
    }
  }
  if (started.postgres !== null) {
    try {
      await started.postgres.stop();
    } catch (error) {
      logWarn("The database did not stop cleanly.", error);
    }
  }
}

/** The end of the server's and the database's logs, which say why a step failed. The app's own log already went to stderr. */
function printLogTails(): void {
  const files = logFilePaths();
  if (files === null) return;
  for (const file of [files.server, files.postgres]) {
    const lines = tailLines(file, LOG_TAIL_LINES);
    process.stderr.write(`\nThe end of ${path.basename(file)}:\n${plain(lines.join("\n"))}\n`);
  }
}

/** Runs every step, prints the results, and gives back the exit code: 0 when all of them worked. */
export async function runSelfTest(files: AppFiles, paths: AppPaths, build: BuildInfo): Promise<number> {
  const results: StepResult[] = [];
  const started: Started = { postgres: null, server: null };
  try {
    await runSteps(files, paths, build, results, started);
  } finally {
    await stopAll(started);
  }
  // It needs neither the database nor the server, so it runs whatever happened above.
  await attempt(results, "autostart", async () => checkAutostart(files, paths), () => "turns start at sign-in on and off");
  // In the order they run. A step that an earlier failure kept from running shows as not reached.
  const steps = STEP_NAMES.map(
    (name) =>
      results.find((result) => result.name === name) ?? {
        name,
        ok: false,
        detail: "not reached, because an earlier step failed",
      },
  );
  const ok = steps.every((step) => step.ok);
  process.stdout.write(`${JSON.stringify({ ok, steps }, null, 2)}\n`);
  if (!ok) printLogTails();
  return ok ? 0 : 1;
}
