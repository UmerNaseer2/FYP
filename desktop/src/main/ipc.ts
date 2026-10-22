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
  BRIDGE,
  SETTINGS,
  STARTUP,
  type FoundDatabase,
  type SaveGithubResult,
  type SettingsView,
  type SignInResult,
  type StartupState,
  type ThemeChoice,
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
    openLogs(): void;
    close(): void;
  };
};

const REFUSED = "Schema Studio refused a request from this page.";

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

  handle(splash, STARTUP.getState, () => startup.getState());
  on(splash, STARTUP.retry, () => startup.retry());
  on(splash, STARTUP.openLogs, () => startup.openLogs());
  handle(splash, STARTUP.copyDetails, () => startup.copyDetails());

  handle(settings, SETTINGS.get, () => handlers.settings.get());
  handle(settings, SETTINGS.saveGithub, (input) => handlers.settings.saveGithub(input));
  on(settings, SETTINGS.setTheme, (choice) => {
    if (isThemeChoice(choice)) handlers.settings.setTheme(choice);
  });
  on(settings, SETTINGS.openLogs, () => handlers.settings.openLogs());
  on(settings, SETTINGS.close, () => handlers.settings.close());
}
