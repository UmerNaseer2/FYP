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
 *    database and the server start, and while a backup is restored. It only
 *    reads progress and offers Retry.
 *  - The Settings window (app://schema-studio/settings.html), including its
 *    Phone section, which runs the phone link, and its Backup section, which
 *    saves and restores backups.
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
  setKeepRunning: "settings:set-keep-running",
  setStartAtLogin: "settings:set-start-at-login",
  setDriftAlerts: "settings:set-drift-alerts",
  openLogs: "settings:open-logs",
  close: "settings:close",
} as const;

/** The Settings window's Phone section. "changed" and "paired" go the other way, from the main process to the page. */
export const PHONE = {
  get: "phone:get",
  changed: "phone:changed",
  paired: "phone:paired",
  setEnabled: "phone:set-enabled",
  setRelay: "phone:set-relay",
  setShared: "phone:set-shared",
  forget: "phone:forget",
  pair: "phone:pair",
  cancelPairing: "phone:cancel-pairing",
  connectNow: "phone:connect-now",
  connections: "phone:connections",
} as const;

/** The Settings window's Backup section. */
export const BACKUP = {
  save: "backup:save",
  choose: "backup:choose",
  restore: "backup:restore",
} as const;

/** The steps the start screen lists, in the order they happen. */
export type StartupStep = "secrets" | "database" | "server" | "sign-in";

/**
 * What the start screen shows. There is no "ready" state: once everything is
 * up, the window simply moves on to Schema Studio itself. While a backup is
 * restored, the screen says so instead, and Schema Studio starts again by
 * itself once the backup is in.
 */
export type StartupState =
  | { phase: "starting"; step: StartupStep }
  | { phase: "restoring" }
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
  /** Whether closing the window leaves the app running, with its icon in the top bar. */
  keepRunning: boolean;
  /** Whether the app starts at sign-in, or null when this copy cannot, such as one run from the source code. */
  startAtLogin: boolean | null;
  /** Whether a scheduled drift check that finds something new shows a notification. */
  driftAlerts: boolean;
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

/** The answer to turning start at sign-in on or off: done, or why not. */
export type StartAtLoginResult = { ok: true } | { ok: false; message: string };

/** What the Settings preload puts on `window.schemaStudioSettings`. */
export interface SettingsApi {
  get(): Promise<SettingsView>;
  saveGithub(input: GithubSettingsInput): Promise<SaveGithubResult>;
  setTheme(choice: ThemeChoice): void;
  setKeepRunning(on: boolean): void;
  setStartAtLogin(on: boolean): Promise<StartAtLoginResult>;
  setDriftAlerts(on: boolean): void;
  openLogs(): void;
  close(): void;
}

/**
 * Where the phone link stands (src/main/phone-link.ts): "off" while it is
 * turned off, "needs-relay" while it has no relay yet, and otherwise where its
 * connection to the relay stands. "waiting" means the connection was lost, or
 * could not be made, for the reason given (written for a person), and the
 * phone link tries again at retryAt. "replaced" means another Schema Studio
 * signed in to the relay as this computer, and this one waits to be told to
 * connect again.
 */
export type PhoneStatus =
  | { state: "off" }
  | { state: "needs-relay" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "waiting"; retryAt: number; reason: string }
  | { state: "replaced" };

/** A paired phone, as the Phone section lists it. The name came from the phone. */
export type PhoneSummary = { key: string; name: string; pairedAt: number; lastSeenAt: number; connected: boolean };

/** What the Phone section shows, or why there is nothing to show yet. */
export type PhoneView =
  | { available: false; message: string }
  | {
      available: true;
      status: PhoneStatus;
      enabled: boolean;
      relayOrigin: string | null;
      /** The saved connections phones may see, by their numbers. */
      sharedConnectionIds: number[];
      phones: PhoneSummary[];
      /** Why a phone cannot pair now, as a sentence for a person, or null when one can. */
      cannotPair: string | null;
    };

/**
 * A new pairing code, as its QR drawing (src/main/qr.ts), and when it runs
 * out, or why a phone cannot pair now. The page never gets the pairing link
 * itself, because the link carries a one-time secret.
 */
export type PhonePairing =
  | { ok: true; expiresAt: number; qr: { size: number; path: string } }
  | { ok: false; message: string };

/** The answer to saving the relay's address: the address as it was saved, or why it was not. */
export type SetRelayResult = { ok: true; relayOrigin: string } | { ok: false; message: string };

/** A saved connection that phones may be allowed to see. Never its host, user name or password. */
export type PhoneConnection = { id: number; name: string; environment: "unset" | "dev" | "staging" | "prod"; database: string };

/** The saved connections, for the Phone section to choose from, or why they could not be listed. */
export type PhoneConnections = { ok: true; connections: PhoneConnection[] } | { ok: false; message: string };

/** What the Settings preload puts on `window.schemaStudioPhone`, for the Phone section. */
export interface PhoneSettingsApi {
  get(): Promise<PhoneView>;
  /** Hears the new view after each change: to the connection, to the phones or to a setting. */
  onChange(listener: (view: PhoneView) => void): void;
  /** Hears the name of a phone that has just paired with the code on show. */
  onPaired(listener: (name: string) => void): void;
  setEnabled(enabled: boolean): void;
  setRelay(origin: string): Promise<SetRelayResult>;
  setShared(ids: number[]): void;
  /** Unpairs a phone, by its key. */
  forget(key: string): void;
  pair(): Promise<PhonePairing>;
  /** Makes the code on show pair nothing. */
  cancelPairing(): void;
  /** Connects to the relay at once instead of waiting to try again. */
  connectNow(): void;
  connections(): Promise<PhoneConnections>;
}

/** The answer to saving a backup: the name of the file it went into, or that the person closed the file dialog, or which box to fix and why. */
export type SaveBackupResult =
  | { ok: true; fileName: string }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "failed"; field: "passphrase" | "repeat" | null; message: string };

/** The answer to choosing a backup to restore: the chosen file's name, or that none was chosen, or why not. */
export type ChooseBackupResult =
  | { ok: true; fileName: string }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "failed"; message: string };

/**
 * The answer to restoring the chosen backup: it is going in, and Schema Studio
 * starts again once it is; or the person said no when asked; or which box to
 * fix and why.
 */
export type RestoreBackupResult =
  | { ok: true }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "failed"; field: "passphrase" | null; message: string };

/**
 * What the Settings preload puts on `window.schemaStudioBackup`, for the
 * Backup section. The page only ever learns a file's name: where the file is
 * stays with the main process, which shows the file dialogs itself.
 */
export interface BackupSettingsApi {
  /** Asks where to save, then saves a backup locked with the passphrase, which the person typed twice. */
  save(passphrase: string, repeat: string): Promise<SaveBackupResult>;
  /** Asks which backup to restore. */
  choose(): Promise<ChooseBackupResult>;
  /** Opens the chosen backup with the passphrase, asks once more, then restores it. */
  restore(passphrase: string): Promise<RestoreBackupResult>;
}
