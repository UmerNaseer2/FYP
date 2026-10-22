/**
 * Two of the start screen's steps, for DesktopApp: unlocking the app's keys
 * (openSecrets) and starting the server (startServerOnFreePort). The step
 * that starts the database is startPostgres, in postgres.ts.
 *
 * Each step returns what the next one needs, or throws a StartupError that
 * says, in words the person can act on, what went wrong. The start screen
 * shows it with a Try again button.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

import type { BuildConfig } from "../core/build-config";
import { displayPath, type AppPaths } from "../core/paths";
import { ensurePrivateDir } from "../core/private-dir";
import {
  emptyAuthState,
  newSecretValues,
  parseAuthState,
  parseSecretValues,
  type AuthState,
  type SecretValues,
} from "../core/secrets-file";
import type { AppFiles } from "./app-files";
import type { ConfigStore } from "./config-store";
import { addLogSecret, logInfo, logWarn } from "./log";
import { choosePort } from "./port";
import { ProtectedStore, type Protection } from "./secrets";
import { ServerExitError, startServer, type RunningServer } from "./server";
import { StartupError } from "./startup-error";

export type OpenedSecrets = {
  /** The keys the server needs, made the first time the app starts. */
  secrets: SecretValues;
  /** Where the keys are kept: locked with the login keyring, or in a file only the person can read. */
  protection: Protection;
  /** secrets.json, for saving a new GitHub token from Settings. */
  store: ProtectedStore<SecretValues>;
  /** auth.json, which keeps the Microsoft sign-in from one start to the next. */
  authStore: ProtectedStore<AuthState>;
  /** The saved Microsoft sign-in, or an empty one. */
  authState: AuthState;
};

/** The keys from secrets.json, or new ones the first time the app starts. */
function openKeys(
  store: ProtectedStore<SecretValues>,
  paths: AppPaths,
  home: string,
): { secrets: SecretValues; protection: Protection } {
  const loaded = store.load();
  switch (loaded.status) {
    case "missing": {
      const secrets = newSecretValues((size) => crypto.randomBytes(size));
      let protection: Protection;
      try {
        protection = store.save(secrets);
      } catch (error) {
        throw new StartupError(
          "Schema Studio could not start",
          `Schema Studio could not save its keys in ${displayPath(paths.secretsFile, home)}. Check that there is space on the disk, then press Try again.`,
          error,
        );
      }
      // A database already there means the keys went missing, rather than
      // this being the first start.
      if (fs.existsSync(paths.postgres)) {
        logWarn(
          "The app's keys were missing, so new ones were made. Connection passwords saved with the old keys cannot be opened, so they need entering again.",
        );
      }
      logInfo(
        protection === "keyring"
          ? "Made new keys for this copy of Schema Studio and locked them in the login keyring."
          : "Made new keys for this copy of Schema Studio and kept them in a file only you can read.",
      );
      return { secrets, protection };
    }
    case "values": {
      let protection = loaded.protection;
      if (loaded.upgrade) {
        try {
          protection = store.save(loaded.values);
          if (protection === "keyring") logInfo("Moved the app's keys into the login keyring.");
        } catch (error) {
          logWarn("Could not move the app's keys into the login keyring, so they stay in a file only you can read.", error);
        }
      }
      return { secrets: loaded.values, protection };
    }
    case "locked":
      logWarn(loaded.message);
      throw new StartupError(
        "Schema Studio could not unlock its keys",
        'Schema Studio keeps its keys in your login keyring, and the keyring did not open. Log out and back in, or unlock the "Login" keyring in Passwords and Keys, then press Try again.',
      );
    case "damaged":
      logWarn(loaded.message);
      throw new StartupError(
        "Schema Studio's keys are damaged",
        `The file that holds Schema Studio's keys (${displayPath(paths.secretsFile, home)}) is damaged. Restore it from a backup, or, to start again from nothing, move the ${displayPath(paths.data, home)} folder somewhere else. Starting again loses your saved connections.`,
      );
  }
}

/**
 * Unlocks the app's keys (making them the first time) and reads the saved
 * Microsoft sign-in. Throws a StartupError when the keys cannot be opened,
 * because starting without them would mean new keys, and every saved
 * connection password lost for good.
 */
export function openSecrets(paths: AppPaths, allowKeyring: boolean): OpenedSecrets {
  // ProtectedStore tidies its folder as soon as it is made, so the folders
  // come first.
  ensurePrivateDir(paths.config);
  ensurePrivateDir(paths.data);
  const home = os.homedir();

  const store = new ProtectedStore<SecretValues>({
    file: paths.secretsFile,
    what: "the app's keys",
    parse: parseSecretValues,
    allowKeyring,
  });
  const { secrets, protection } = openKeys(store, paths, home);
  addLogSecret(secrets.nextauthSecret);
  addLogSecret(secrets.appEncryptionKey);
  addLogSecret(secrets.githubToken);

  const authStore = new ProtectedStore<AuthState>({
    file: paths.authFile,
    what: "the Microsoft sign-in",
    parse: parseAuthState,
    allowKeyring,
  });
  let authState = emptyAuthState();
  const saved = authStore.load();
  if (saved.status === "values") {
    authState = saved.values;
    if (saved.upgrade) {
      try {
        authStore.save(authState);
      } catch (error) {
        logWarn("Could not move the Microsoft sign-in into the login keyring.", error);
      }
    }
  } else if (saved.status !== "missing") {
    // Damaged or locked. Signing in again is all it costs.
    logWarn(`${saved.message} You need to sign in again.`);
  }

  return { secrets, protection, store, authStore, authState };
}

export type StartServerOnFreePortOptions = {
  files: AppFiles;
  config: ConfigStore;
  /** The database's socket folder. */
  socketDir: string;
  buildConfig: BuildConfig;
  secrets: SecretValues;
  gateToken: string;
  /** Aborted when the app quits while the server is still starting. */
  signal: AbortSignal;
};

/** Remembers the server's port for next time. The store logs a save that fails. */
function savePort(config: ConfigStore, port: number): void {
  const current = config.get();
  if (current.port === port) return;
  config.save({ ...current, port });
}

/**
 * Starts the server on the port it had last time, or on a free one. When
 * the server stops before it starts listening (another program took the
 * port a moment after it was checked, say), it has one more go on a
 * different port.
 */
export async function startServerOnFreePort(options: StartServerOnFreePortOptions): Promise<RunningServer> {
  const { config, signal } = options;
  const startOn = async (port: number): Promise<RunningServer> => {
    const server = await startServer({
      files: options.files,
      port,
      socketDir: options.socketDir,
      buildConfig: options.buildConfig,
      secrets: options.secrets,
      gateToken: options.gateToken,
      github: config.get().github,
      signal,
    });
    savePort(config, port);
    return server;
  };

  const first = await choosePort(config.get().port);
  try {
    return await startOn(first);
  } catch (error) {
    if (!(error instanceof ServerExitError) || !error.beforeListening || signal.aborted) throw error;
    logWarn(`Schema Studio's server could not start on port ${first}, so it is trying another port.`, error);
  }

  const second = await choosePort(null, first);
  try {
    return await startOn(second);
  } catch (error) {
    if (error instanceof ServerExitError) {
      throw new StartupError(
        "Schema Studio could not start",
        "Schema Studio's server stopped while starting. Open the logs for details.",
        error,
      );
    }
    throw error;
  }
}
