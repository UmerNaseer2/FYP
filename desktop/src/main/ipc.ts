/**
 * The messages the app's pages may send to the main process, and who may
 * send each one.
 *
 * Three pages talk to the main process, each through its own preload
 * script: the splash, while the app starts; Settings; and Schema Studio
 * itself, which the app's own server sends. Every message is checked before
 * it is acted on. It must come from the right window, from the page itself
 * rather than a frame inside it, and from the right page. So even a page
 * that somehow got into a window could not, say, read the settings or start
 * a sign-in. Anything else is refused, and the refusal is written to the
 * log once for each kind of message.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";

import { isThemeChoice } from "../core/config";
import {
  BACKUP,
  BRIDGE,
  CLOUD,
  PHONE,
  SETTINGS,
  STARTUP,
  type ChooseBackupResult,
  type CloudLinkResult,
  type CloudView,
  type FoundDatabase,
  type PhoneConnections,
  type PhonePairing,
  type PhoneView,
  type RestoreBackupResult,
  type SaveBackupResult,
  type SaveGithubResult,
  type SetRelayResult,
  type SettingsView,
  type SignInResult,
  type StartAtLoginResult,
  type StartupState,
  type SyncAnswer,
  type SyncStatus,
  type ThemeChoice,
  type WebsiteDrift,
} from "../shared/ipc";
import { logWarn } from "./log";
import { APP_HOST } from "./protocol";

/** Who may send a message: a page from the app's server, or one of the app's own pages, in a given window. */
type Rule =
  | { kind: "server"; contents(): WebContents | null; origin(): string | null }
  | { kind: "page"; contents(): WebContents | null; path: "/splash.html" | "/settings.html" };

export type IpcHandlers = {
  /** The main window's page, or null when the window has closed. */
  mainContents(): WebContents | null;
  /** The Settings window's page, or null when Settings is not open. */
  settingsContents(): WebContents | null;
  /** The server's address, such as http://127.0.0.1:4100, or null before it has started. */
  serverOrigin(): string | null;
  bridge: {
    signIn(): Promise<SignInResult>;
    cancelSignIn(): void;
    signOut(): Promise<void>;
    findLocalDatabases(): Promise<FoundDatabase[]>;
    setTheme(choice: ThemeChoice): void;
    openSettings(): void;
    syncStatus(): SyncStatus;
    syncCreate(connection: Record<string, unknown>): Promise<SyncAnswer>;
    syncUpdate(siteId: number, connection: Record<string, unknown>): Promise<SyncAnswer>;
    syncRemove(siteId: number, baseVersion: number | null, confirm: boolean): Promise<SyncAnswer>;
    syncSendUp(localId: number): Promise<SyncAnswer>;
    syncDrift(): Promise<WebsiteDrift>;
  };
  startup: {
    getState(): StartupState;
    retry(): void;
    openLogs(): void;
    copyDetails(): Promise<void>;
  };
  settings: {
    get(): SettingsView;
    /** Takes what the page sent as it is; it is checked before anything is saved. */
    saveGithub(input: unknown): SaveGithubResult;
    setTheme(choice: ThemeChoice): void;
    setKeepRunning(on: boolean): void;
    setStartAtLogin(on: boolean): StartAtLoginResult;
    setDriftAlerts(on: boolean): void;
    openLogs(): void;
    close(): void;
  };
  /** The Settings window's Phone section (src/main/phone-settings.ts). */
  phone: {
    get(): PhoneView;
    setEnabled(enabled: boolean): void;
    setKeepAwake(keepAwake: boolean): void;
    /** Takes what the page sent as it is; it is read before it is used. */
    setRelay(origin: unknown): SetRelayResult;
    setShared(ids: unknown): void;
    setQueryText(ids: unknown): void;
    forget(key: string): void;
    allowApprovals(key: string): void;
    turnOffApprovals(key: string): void;
    allowControl(key: string): void;
    turnOffControl(key: string): void;
    pair(): Promise<PhonePairing>;
    cancelPairing(): void;
    connectNow(): void;
    connections(): Promise<PhoneConnections>;
  };
  /** The Settings window's Web site section (src/main/cloud-agent.ts). */
  cloud: {
    get(): CloudView;
    link(origin: string): Promise<CloudLinkResult>;
    cancelLink(): void;
    unlink(): void;
  };
  /** The Settings window's Backup section. */
  backup: {
    save(passphrase: string, repeat: string): Promise<SaveBackupResult>;
    choose(): Promise<ChooseBackupResult>;
    restore(passphrase: string): Promise<RestoreBackupResult>;
  };
};

const REFUSED = "Schema Studio refused a request from this page.";

function isRowNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A connection's number, or a refusal. */
function rowNumber(value: unknown): number {
  if (!isRowNumber(value)) throw new Error(REFUSED);
  return value;
}

/** A connection's fields as the page sent them, or a refusal. The site checks each one before it keeps it. */
function plainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(REFUSED);
  }
  return value as Record<string, unknown>;
}

/** The address of the page that sent the message, when it was the page itself and not a frame inside it. */
function senderUrl(event: IpcMainEvent | IpcMainInvokeEvent): URL | null {
  try {
    const frame = event.senderFrame;
    if (frame === null || frame.parent !== null) return null;
    return new URL(frame.url);
  } catch {
    // The page has gone, or its address could not be read.
    return null;
  }
}

function allowed(rule: Rule, event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const contents = rule.contents();
  if (contents === null || event.sender !== contents) return false;
  const url = senderUrl(event);
  if (url === null) return false;
  if (rule.kind === "server") {
    const origin = rule.origin();
    return origin !== null && url.origin === origin;
  }
  return url.protocol === "app:" && url.host === APP_HOST && url.pathname === rule.path;
}

/** Listens for every message the pages send. Called once, before any window opens. */
export function registerIpc(handlers: IpcHandlers): void {
  const logged = new Set<string>();
  const refuse = (channel: string) => {
    if (logged.has(channel)) return;
    logged.add(channel);
    logWarn(`Refused a "${channel}" message from a page that may not send it.`);
  };
  // A message the page waits for an answer to.
  const handle = (rule: Rule, channel: string, run: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!allowed(rule, event)) {
        refuse(channel);
        throw new Error(REFUSED);
      }
      return run(...args);
    });
  };
  // A message that needs no answer.
  const on = (rule: Rule, channel: string, run: (...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (!allowed(rule, event)) {
        refuse(channel);
        return;
      }
      run(...args);
    });
  };

  const studio: Rule = { kind: "server", contents: handlers.mainContents, origin: handlers.serverOrigin };
  const splash: Rule = { kind: "page", contents: handlers.mainContents, path: "/splash.html" };
  const settings: Rule = { kind: "page", contents: handlers.settingsContents, path: "/settings.html" };
  const { bridge, startup } = handlers;

  handle(studio, BRIDGE.signIn, () => bridge.signIn());
  on(studio, BRIDGE.cancelSignIn, () => bridge.cancelSignIn());
  handle(studio, BRIDGE.signOut, () => bridge.signOut());
  handle(studio, BRIDGE.findLocalDatabases, () => bridge.findLocalDatabases());
  on(studio, BRIDGE.setTheme, (choice) => {
    if (isThemeChoice(choice)) bridge.setTheme(choice);
  });
  on(studio, BRIDGE.openSettings, () => bridge.openSettings());
  handle(studio, BRIDGE.syncStatus, () => bridge.syncStatus());
  handle(studio, BRIDGE.syncCreate, (connection) => bridge.syncCreate(plainObject(connection)));
  handle(studio, BRIDGE.syncUpdate, (siteId, connection) => bridge.syncUpdate(rowNumber(siteId), plainObject(connection)));
  handle(studio, BRIDGE.syncRemove, (siteId, baseVersion, confirm) => {
    if ((baseVersion !== null && !isRowNumber(baseVersion)) || typeof confirm !== "boolean") throw new Error(REFUSED);
    return bridge.syncRemove(rowNumber(siteId), baseVersion, confirm);
  });
  handle(studio, BRIDGE.syncSendUp, (localId) => bridge.syncSendUp(rowNumber(localId)));
  handle(studio, BRIDGE.syncDrift, () => bridge.syncDrift());

  handle(splash, STARTUP.getState, () => startup.getState());
  on(splash, STARTUP.retry, () => startup.retry());
  on(splash, STARTUP.openLogs, () => startup.openLogs());
  handle(splash, STARTUP.copyDetails, () => startup.copyDetails());

  handle(settings, SETTINGS.get, () => handlers.settings.get());
  handle(settings, SETTINGS.saveGithub, (input) => handlers.settings.saveGithub(input));
  on(settings, SETTINGS.setTheme, (choice) => {
    if (isThemeChoice(choice)) handlers.settings.setTheme(choice);
  });
  on(settings, SETTINGS.setKeepRunning, (keep) => {
    if (typeof keep === "boolean") handlers.settings.setKeepRunning(keep);
  });
  handle(settings, SETTINGS.setStartAtLogin, (start) => {
    if (typeof start !== "boolean") throw new Error(REFUSED);
    return handlers.settings.setStartAtLogin(start);
  });
  on(settings, SETTINGS.setDriftAlerts, (alerts) => {
    if (typeof alerts === "boolean") handlers.settings.setDriftAlerts(alerts);
  });
  on(settings, SETTINGS.openLogs, () => handlers.settings.openLogs());
  on(settings, SETTINGS.close, () => handlers.settings.close());

  handle(settings, PHONE.get, () => handlers.phone.get());
  on(settings, PHONE.setEnabled, (enabled) => {
    if (typeof enabled === "boolean") handlers.phone.setEnabled(enabled);
  });
  on(settings, PHONE.setKeepAwake, (keepAwake) => {
    if (typeof keepAwake === "boolean") handlers.phone.setKeepAwake(keepAwake);
  });
  handle(settings, PHONE.setRelay, (origin) => handlers.phone.setRelay(origin));
  on(settings, PHONE.setShared, (ids) => handlers.phone.setShared(ids));
  on(settings, PHONE.setQueryText, (ids) => handlers.phone.setQueryText(ids));
  on(settings, PHONE.forget, (key) => {
    if (typeof key === "string") handlers.phone.forget(key);
  });
  on(settings, PHONE.allowApprovals, (key) => {
    if (typeof key === "string") handlers.phone.allowApprovals(key);
  });
  on(settings, PHONE.turnOffApprovals, (key) => {
    if (typeof key === "string") handlers.phone.turnOffApprovals(key);
  });
  on(settings, PHONE.allowControl, (key) => {
    if (typeof key === "string") handlers.phone.allowControl(key);
  });
  on(settings, PHONE.turnOffControl, (key) => {
    if (typeof key === "string") handlers.phone.turnOffControl(key);
  });
  handle(settings, PHONE.pair, () => handlers.phone.pair());
  on(settings, PHONE.cancelPairing, () => handlers.phone.cancelPairing());
  on(settings, PHONE.connectNow, () => handlers.phone.connectNow());
  handle(settings, PHONE.connections, () => handlers.phone.connections());

  handle(settings, CLOUD.get, () => handlers.cloud.get());
  handle(settings, CLOUD.link, (origin) => {
    if (typeof origin !== "string") throw new Error(REFUSED);
    return handlers.cloud.link(origin);
  });
  on(settings, CLOUD.cancelLink, () => handlers.cloud.cancelLink());
  on(settings, CLOUD.unlink, () => handlers.cloud.unlink());

  handle(settings, BACKUP.save, (passphrase, repeat) => {
    if (typeof passphrase !== "string" || typeof repeat !== "string") throw new Error(REFUSED);
    return handlers.backup.save(passphrase, repeat);
  });
  handle(settings, BACKUP.choose, () => handlers.backup.choose());
  handle(settings, BACKUP.restore, (passphrase) => {
    if (typeof passphrase !== "string") throw new Error(REFUSED);
    return handlers.backup.restore(passphrase);
  });
}
