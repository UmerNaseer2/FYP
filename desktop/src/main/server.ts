/**
 * Runs Schema Studio's server: the same Next.js server the web version runs,
 * in an Electron utility process (a separate Node.js process that Electron
 * looks after), started through src/server/desktop-launcher.ts.
 *
 * The server listens on 127.0.0.1 only, and answers only requests that carry
 * the gate token, which only the app's own windows send (see
 * src/server/desktop-gate.ts and src/main/security.ts).
 *
 * The secrets the server needs (the key for its sign-in cookies, the key
 * that locks saved connection passwords, the GitHub token) are not put in
 * the environment it starts with, which other programs running as the same
 * person can read in /proc. They go in the first message to the launcher
 * instead, which sets them inside the process before the server's code runs.
 */
import { utilityProcess } from "electron";

import type { BuildConfig } from "../core/build-config";
import { metadataDatabaseUrl } from "../core/postgres-files";
import type { SecretValues } from "../core/secrets-file";
import type { LauncherGithub, LauncherStart } from "../server/desktop-launcher";
import type { AppFiles } from "./app-files";
import { logError, logInfo, logWarn, serverLogWriter } from "./log";
import { StartupError } from "./startup-error";

export type StartServerOptions = {
  files: AppFiles;
  port: number;
  /** The database's socket folder, for DATABASE_URL_A. */
  socketDir: string;
  buildConfig: BuildConfig;
  secrets: SecretValues;
  gateToken: string;
  /** The schema registry's repository, from config.json; empty when not set. */
  github: { owner: string; repo: string };
  /** Aborted when the app quits while the server is still starting. */
  signal: AbortSignal;
};

export type RunningServer = {
  port: number;
  /** http://127.0.0.1:<port> */
  origin: string;
  stop(): Promise<void>;
  /** Passes new GitHub settings to the running server, which reads them when it next needs them. */
  sendGithub(owner: string, repo: string, token: string | null): void;
  /** Runs if the server stops while the app is still using it. */
  onUnexpectedExit(listener: (description: string) => void): void;
};

/** The server ended before it was ready. */
export class ServerExitError extends Error {
  /** The exit status, when the server's process ended. */
  readonly code: number | null;
  /** True when it ended before it started listening, which another port may fix. */
  readonly beforeListening: boolean;

  constructor(message: string, code: number | null, beforeListening: boolean) {
    super(message);
    this.name = "ServerExitError";
    this.code = code;
    this.beforeListening = beforeListening;
  }
}

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;

/**
 * The environment the server starts with. It is built from nothing, so none
 * of the person's own settings (NODE_OPTIONS, a PGHOST) reach the server.
 */
function serverEnv(options: StartServerOptions): Record<string, string> {
  const env: Record<string, string> = {
    NODE_ENV: "production",
    PORT: String(options.port),
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
    SCHEMA_STUDIO_DESKTOP: "1",
    NEXT_PUBLIC_AUTH_BYPASS: "false",
    DATABASE_URL_A: metadataDatabaseUrl(options.socketDir),
    // The person's databases are on this computer or their own network,
    // which the web version's server refuses to connect to.
    ALLOW_PRIVATE_DB_HOSTS: "true",
  };
  const { clientId, tenantId } = options.buildConfig;
  if (clientId !== null) env.AZURE_AD_CLIENT_ID = clientId;
  if (tenantId !== null) env.AZURE_AD_TENANT_ID = tenantId;
  if (options.github.owner !== "" && options.github.repo !== "") {
    env.GITHUB_REPO_OWNER = options.github.owner;
    env.GITHUB_REPO_NAME = options.github.repo;
  }
  for (const name of ["HOME", "PATH", "TZ", "TMPDIR", "LANG"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  options.signal.throwIfAborted();
  const { files, port, signal } = options;
  const origin = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  logInfo(`Starting Schema Studio's server on port ${port}.`);

  const child = utilityProcess.fork(files.launcher, [], {
    serviceName: "Schema Studio server",
    cwd: files.serverDir,
    stdio: "pipe",
    env: serverEnv(options),
  });

  const out = serverLogWriter("stdout");
  const err = serverLogWriter("stderr");
  child.stdout?.on("data", (chunk: Buffer | string) => out.write(chunk));
  child.stdout?.on("end", () => out.flush());
  child.stderr?.on("data", (chunk: Buffer | string) => err.write(chunk));
  child.stderr?.on("end", () => err.flush());

  // Changed from the event handlers below, so kept in an object rather than
  // in variables the compiler would think it can predict.
  const state = { listening: false, stopping: false, exited: false, unexpected: null as string | null };
  const listeners: ((description: string) => void)[] = [];
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  child.on("error", (type, location) => logError(`Schema Studio's server hit a fatal error (${type} at ${location}).`));
  child.on("exit", (code) => {
    state.exited = true;
    if (state.stopping) {
      logInfo(`Schema Studio's server stopped (exit status ${code}).`);
      return;
    }
    // Before it was listening, the wait below reports it.
    if (!state.listening) return;
    const description = `exit status ${code}`;
    state.unexpected = description;
    logError(`Schema Studio's server stopped unexpectedly (${description}).`);
    for (const listener of listeners) listener(description);
  });

  child.once("spawn", () => {
    const start: LauncherStart = {
      type: "start",
      serverDir: files.serverDir,
      gateToken: options.gateToken,
      nextauthSecret: options.secrets.nextauthSecret,
      appEncryptionKey: options.secrets.appEncryptionKey,
      githubToken: options.secrets.githubToken,
    };
    child.postMessage(start);
  });

  async function stop(): Promise<void> {
    state.stopping = true;
    if (state.exited) return;
    child.kill();
    if (await settlesWithin(exited, STOP_TIMEOUT_MS)) return;
    logWarn("Schema Studio's server did not stop within 5 seconds, so it is being killed.");
    const pid = child.pid;
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone by now.
      }
    }
    await settlesWithin(exited, 2_000);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (error === null) resolve();
        else reject(error);
      };
      const timer = setTimeout(
        () =>
          settle(
            new StartupError(
              "Schema Studio could not start",
              "Schema Studio's server did not finish starting within a minute. Open the logs for details.",
            ),
          ),
        START_TIMEOUT_MS,
      );
      const onAbort = () => settle(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("message", (message: unknown) => {
        if (typeof message !== "object" || message === null) return;
        const { type, message: text } = message as { type?: unknown; message?: unknown };
        if (type === "listening") {
          state.listening = true;
          settle(null);
        } else if (type === "fatal") {
          settle(new ServerExitError(`Schema Studio's server could not start: ${String(text)}`, null, true));
        }
      });
      child.once("exit", (code: number) =>
        settle(new ServerExitError(`Schema Studio's server ended (exit status ${code}) before it was ready.`, code, true)),
      );
    });
  } catch (error) {
    await stop();
    throw error;
  }

  logInfo(`Schema Studio's server is ready, after ${((Date.now() - startedAt) / 1000).toFixed(1)} seconds.`);
  return {
    port,
    origin,
    stop,
    sendGithub(owner, repo, token) {
      if (state.exited) return;
      const message: LauncherGithub = { type: "github", owner, repo, token };
      child.postMessage(message);
    },
    onUnexpectedExit(listener) {
      if (state.unexpected !== null) listener(state.unexpected);
      else listeners.push(listener);
    },
  };
}
