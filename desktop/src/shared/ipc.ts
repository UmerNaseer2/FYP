/**
 * Every message that crosses between the app's windows and its main process,
 * named in one place.
 *
 * There are three kinds of page, and each gets its own small set of channels:
 *
 *  - The Schema Studio pages themselves, served by the app's own Next server on
 *    http://127.0.0.1. They get the web app's desktop bridge (see bridge.ts),
 *    and nothing else.
 *  - The start screen (app://schema-studio/splash.html), shown while the
 *    database and the server start. It only reads progress and offers Retry.
 *  - The Settings window (app://schema-studio/settings.html).
 *
 * The main process checks, on every message, that it came from the right kind
 * of page in one of the app's own windows (src/main/ipc.ts), so a page can
 * never use another page's channels.
 *
 * This file must stay free of Node and of the DOM: the main process, the
 * preload scripts and the two app:// pages all compile against it.
 */

/**
 * How a Microsoft sign-in in the system browser ended, as the web app's bridge
 * promises it. src/contract/bridge-contract.ts fails the build if this and the
 * web app's copy (my-app/lib/desktop-bridge.ts) ever stop matching.
 */
export type SignInResult =
  | { ok: true; idToken: string }
  | { ok: false; reason: "cancelled" | "offline" | "failed"; message: string };

/** A database found running on this computer, for the Connections screen. */
export type FoundDatabase = {
  source: "port" | "docker";
  label: string;
  host: string;
  port: number;
  user: string | null;
  database: string | null;
  container?: string;
};

/** "system" follows Ubuntu's light or dark style; the other two pin one. */
export type ThemeChoice = "system" | "light" | "dark";

/** The web app's bridge (my-app/lib/desktop-bridge.ts). */
export const BRIDGE = {
  signIn: "desktop:sign-in",
  cancelSignIn: "desktop:cancel-sign-in",
  signOut: "desktop:sign-out",
  findLocalDatabases: "desktop:find-local-databases",
  setTheme: "desktop:set-theme",
  openSettings: "desktop:open-settings",
} as const;

/** The start screen. */
export const STARTUP = {
  getState: "startup:get-state",
  status: "startup:status",
  retry: "startup:retry",
  openLogs: "startup:open-logs",
  copyDetails: "startup:copy-details",
} as const;

/** The Settings window. */
export const SETTINGS = {
  get: "settings:get",
  saveGithub: "settings:save-github",
  setTheme: "settings:set-theme",
  openLogs: "settings:open-logs",
  close: "settings:close",
} as const;

/** The steps the start screen lists, in the order they happen. */
export type StartupStep = "secrets" | "database" | "server" | "sign-in";

/**
 * What the start screen shows. There is no "ready" state: once everything is
 * up, the window simply moves on to Schema Studio itself.
 */
export type StartupState =
  | { phase: "starting"; step: StartupStep }
  | { phase: "failed"; title: string; message: string };

/** What the start screen's preload puts on `window.schemaStudioStartup`. */
export interface StartupApi {
  getState(): Promise<StartupState>;
  onStatus(listener: (state: StartupState) => void): void;
  retry(): void;
  openLogs(): void;
  /** Copies the diagnostics (secrets removed) to the clipboard. */
  copyDetails(): Promise<void>;
}

/**
 * What the Settings window shows. The access token itself never leaves the
 * main process: the page is only told whether one is saved.
 */
export type SettingsView = {
  github: { owner: string; repo: string; hasToken: boolean };
  theme: ThemeChoice;
  /** Where the app keeps its secrets: the system keyring, or a private file. */
  secretsKeptIn: "keyring" | "file";
  paths: { data: string; logs: string };
  version: string;
};

/** What Save sends. The token is only ever replaced, removed or left alone. */
export type GithubSettingsInput = {
  owner: string;
  repo: string;
  token: { action: "keep" } | { action: "replace"; value: string } | { action: "remove" };
};

/** The answer to Save: the new view, or which field to fix and why. */
export type SaveGithubResult =
  | { ok: true; view: SettingsView }
  | { ok: false; field: "owner" | "repo" | "token" | null; message: string };

/** What the Settings preload puts on `window.schemaStudioSettings`. */
export interface SettingsApi {
  get(): Promise<SettingsView>;
  saveGithub(input: GithubSettingsInput): Promise<SaveGithubResult>;
  setTheme(choice: ThemeChoice): void;
  openLogs(): void;
  close(): void;
}
