/**
 * The app's two windows: the main one, and Settings.
 *
 * The main window shows the splash while the app starts, then Schema Studio
 * itself, which the app's own server sends from this computer. It opens
 * where it was last left and at the size it was left, unless that place is
 * no longer on any screen. With Keep running on, closing it only hides it
 * (src/main/desktop-app.ts), and a start in the background, at sign-in,
 * leaves it hidden until it is opened again. Settings is a small window of
 * its own on top of it.
 *
 * Both are locked down the same way: the page runs in Chromium's sandbox,
 * cannot reach Node.js, and only gets the few functions its preload script
 * hands it. They share one session, "persist:app", so the sign-in cookie
 * survives a restart. The rules that session follows are in security.ts.
 */
import { app, BrowserWindow, screen, type WebPreferences } from "electron";

import type { SavedWindow } from "../core/config";
import { placeWindow } from "../core/window-state";
import type { AppFiles } from "./app-files";
import { logWarn } from "./log";
import { APP_ORIGIN } from "./protocol";
import { windowBackground } from "./theme";

export const APP_PARTITION = "persist:app";

/** How long the window waits after moving or resizing before its place is saved, so a drag saves once. */
const SAVE_DELAY_MS = 500;
/** How long a window waits for its first page to be drawn before it shows anyway. */
const SHOW_LIMIT_MS = 5_000;

function securePreferences(preload: string, packaged: boolean): WebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    partition: APP_PARTITION,
    devTools: !packaged,
    // A file dropped on the window would otherwise replace the page.
    navigateOnDragDrop: false,
    // A page that opens dialog after dialog gets a way to stop them.
    safeDialogs: true,
  };
}

/** On Wayland a program cannot see or choose where its windows are, only their size. */
function onWayland(): boolean {
  if (process.platform !== "linux") return false;
  const chosen = app.commandLine.getSwitchValue("ozone-platform");
  if (chosen !== "") return chosen === "wayland";
  // Electron uses Wayland whenever the session offers it.
  return Boolean(process.env.WAYLAND_DISPLAY);
}

function clampSize(value: number): number {
  return Math.min(20_000, Math.max(200, Math.round(value)));
}

/**
 * Shows the window once its first page has been drawn, so it never flashes
 * an empty frame. A page that fails to load may never be drawn, so after a
 * few seconds the window shows whatever happens: an app that seems not to
 * start at all is worse than a blank window.
 */
function showWhenReady(window: BrowserWindow, maximized: boolean): void {
  let shown = false;
  const show = () => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    clearTimeout(fallback);
    // maximize() shows the window as well.
    if (maximized) window.maximize();
    else window.show();
  };
  const fallback = setTimeout(show, SHOW_LIMIT_MS);
  window.once("ready-to-show", show);
}

/** Saves where the window is a moment after it moves or changes size, and at once when it closes. */
function rememberPlace(window: BrowserWindow, save: (saved: SavedWindow) => void): void {
  const wayland = onWayland();
  let timer: NodeJS.Timeout | null = null;
  const saveNow = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // A hidden window, closed to the top bar or not shown yet, is not where
    // the person left it, and on X11 it can report that it is not maximized.
    if (window.isDestroyed() || !window.isVisible()) return;
    // The size it has when not maximized, so un-maximizing after a restart gives it back.
    const bounds = window.getNormalBounds();
    save({
      // Wayland gives every window the place 0,0, which is not worth keeping.
      x: wayland ? null : Math.round(bounds.x),
      y: wayland ? null : Math.round(bounds.y),
      width: clampSize(bounds.width),
      height: clampSize(bounds.height),
      maximized: window.isMaximized(),
    });
  };
  const saveSoon = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(saveNow, SAVE_DELAY_MS);
  };
  window.on("resize", saveSoon);
  window.on("move", saveSoon);
  window.on("maximize", saveSoon);
  window.on("unmaximize", saveSoon);
  window.on("close", saveNow);
}

export type MainWindowOptions = {
  files: AppFiles;
  /** Where the window was last left, if anywhere. */
  saved: SavedWindow | null;
  packaged: boolean;
  /** Starts the window hidden, for a start in the background. Showing it is then up to the caller. */
  hidden: boolean;
  /** Called with where the window is, a moment after it moves or changes size. */
  saveWindow(saved: SavedWindow): void;
};

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const { files, packaged } = options;
  const placement = placeWindow(
    options.saved,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  );
  const window = new BrowserWindow({
    ...placement.bounds,
    minWidth: placement.minWidth,
    minHeight: placement.minHeight,
    show: false,
    title: "Schema Studio",
    icon: files.icon,
    backgroundColor: windowBackground(),
    webPreferences: securePreferences(files.appPreload, packaged),
  });
  // The web app's pages carry the web version's title, which would replace
  // this one. The title bar and the window switcher keep the app's own name,
  // the one the app grid and the dock show.
  window.on("page-title-updated", (event) => event.preventDefault());
  if (!options.hidden) showWhenReady(window, placement.maximized);
  rememberPlace(window, options.saveWindow);
  return window;
}

/** Settings, as a window of its own that keeps the main window waiting until it closes. */
export function createSettingsWindow(parent: BrowserWindow, files: AppFiles, packaged: boolean): BrowserWindow {
  const window = new BrowserWindow({
    parent,
    modal: true,
    width: 560,
    height: 640,
    minWidth: 480,
    minHeight: 480,
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Settings",
    icon: files.icon,
    backgroundColor: windowBackground(),
    webPreferences: securePreferences(files.settingsPreload, packaged),
  });
  window.setMenu(null);
  showWhenReady(window, false);
  window.loadURL(`${APP_ORIGIN}/settings.html`).catch((error: unknown) => logWarn("Could not open Settings.", error));
  return window;
}
