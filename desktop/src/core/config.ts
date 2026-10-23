/**
 * The app's small settings file, config.json: the port its server uses, the
 * window's size and place, the light or dark choice, whether closing the
 * window keeps the app running, and which GitHub repository holds the schema
 * registry. Nothing secret goes in here (the access token is in secrets.json,
 * protected by the keyring).
 *
 * Every field is checked on its own when the file is read. A damaged or
 * hand-edited field falls back to its default and the rest are kept, so one
 * bad value can never stop the app from opening.
 *
 * Pure: reading and writing the file is src/main/config-store.ts.
 */
import type { ThemeChoice } from "../shared/ipc";
import { isSavedRegistryValid } from "./github-settings";

export type SavedWindow = {
  /** null on a first run, or where the desktop does not report positions (Wayland). */
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  maximized: boolean;
};

export type AppConfig = {
  version: 1;
  /** The local port the app's server listens on, picked on first run. */
  port: number | null;
  window: SavedWindow | null;
  theme: ThemeChoice;
  /**
   * Whether closing the window leaves Schema Studio running, with an icon in
   * the top bar, so that paired phones can still reach it. Off at first:
   * closing the window then quits, as people expect.
   */
  keepRunning: boolean;
  github: { owner: string; repo: string };
};

export function defaultConfig(): AppConfig {
  return { version: 1, port: null, window: null, theme: "system", keepRunning: false, github: { owner: "", repo: "" } };
}

/** Ports the app may use: any unprivileged one, from 1024 up. */
export function isUsablePort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function isWholeNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function readWindow(value: unknown): SavedWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const w = value as Record<string, unknown>;
  // Sizes beyond any real screen are refused rather than trusted.
  if (!isWholeNumber(w.width, 200, 20000) || !isWholeNumber(w.height, 200, 20000)) return null;
  const hasPlace = isWholeNumber(w.x, -100000, 100000) && isWholeNumber(w.y, -100000, 100000);
  return {
    x: hasPlace ? (w.x as number) : null,
    y: hasPlace ? (w.y as number) : null,
    width: w.width,
    height: w.height,
    maximized: w.maximized === true,
  };
}

/**
 * True only for the three choices the app knows. Also used on what a page
 * sends when someone picks a theme, since a page's message is never trusted.
 */
export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

function readTheme(value: unknown): ThemeChoice {
  return isThemeChoice(value) ? value : "system";
}

function readGithub(value: unknown): { owner: string; repo: string } {
  if (typeof value !== "object" || value === null) return { owner: "", repo: "" };
  const g = value as Record<string, unknown>;
  return isSavedRegistryValid(g.owner, g.repo)
    ? { owner: g.owner as string, repo: g.repo as string }
    : { owner: "", repo: "" };
}

/** True when the saved registry came back as it was, whichever order its two names were saved in. */
function sameGithub(value: unknown, read: { owner: string; repo: string }): boolean {
  if (typeof value !== "object" || value === null) return false;
  const g = value as Record<string, unknown>;
  return g.owner === read.owner && g.repo === read.repo;
}

/**
 * Reads config.json's text. `null` (no file yet) and anything unreadable both
 * give the defaults; `damaged` says whether there was something to complain
 * about, for the log.
 */
export function parseConfig(text: string | null): { config: AppConfig; damaged: boolean } {
  if (text === null) return { config: defaultConfig(), damaged: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: defaultConfig(), damaged: true };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config: defaultConfig(), damaged: true };
  }
  const r = raw as Record<string, unknown>;
  const config: AppConfig = {
    version: 1,
    port: isUsablePort(r.port) ? r.port : null,
    window: readWindow(r.window),
    theme: readTheme(r.theme),
    keepRunning: r.keepRunning === true,
    github: readGithub(r.github),
  };
  const damaged =
    r.version !== 1 ||
    (r.port !== undefined && r.port !== null && config.port === null) ||
    (r.window !== undefined && r.window !== null && config.window === null) ||
    (r.theme !== undefined && r.theme !== config.theme) ||
    (r.keepRunning !== undefined && typeof r.keepRunning !== "boolean") ||
    (r.github !== undefined && !sameGithub(r.github, config.github));
  return { config, damaged };
}

export function serializeConfig(config: AppConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}
