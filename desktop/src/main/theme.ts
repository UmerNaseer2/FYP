/**
 * Light or dark. "Match Ubuntu" follows the desktop's own setting (Settings >
 * Appearance), which Electron reads through the desktop portal, and Light or
 * Dark override it. Setting nativeTheme.themeSource changes what
 * prefers-color-scheme says inside every window, so the web app, the start
 * screen and Settings all switch together, live.
 */
import { nativeTheme } from "electron";

import type { ThemeChoice } from "../shared/ipc";

export function applyTheme(choice: ThemeChoice): void {
  nativeTheme.themeSource = choice;
}

/**
 * The color a window is filled with before its page has painted: the app's
 * background, so opening a window never flashes white in dark mode.
 */
export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#0a0a0c" : "#f7f7f8";
}

/** Runs when light or dark changes, by choice or because Ubuntu's setting did. */
export function onThemeUpdated(listener: () => void): void {
  nativeTheme.on("updated", listener);
}
