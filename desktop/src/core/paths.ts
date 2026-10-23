/**
 * Where the app keeps things on disk, following the XDG Base Directory rules
 * that every Ubuntu desktop uses:
 *
 *   ~/.config/schema-studio        Electron's own profile (the sign-in cookie,
 *                                  window caches) plus config.json, the
 *                                  saved Microsoft sign-in (auth.json) and
 *                                  the paired phones (phone-link.json).
 *   ~/.local/share/schema-studio   The app's real data: its own PostgreSQL
 *                                  database and the keys that protect what is
 *                                  saved in it (secrets.json). These two live
 *                                  side by side on purpose: the database is
 *                                  useless without its keys, so a backup or a
 *                                  move of this one folder takes both.
 *   ~/.local/state/schema-studio   Logs, which can be deleted at any time.
 *
 * Each of the three can be moved with XDG_CONFIG_HOME, XDG_DATA_HOME and
 * XDG_STATE_HOME. The rules say a relative path in one of those variables is
 * invalid and must be ignored, so it is.
 *
 * Pure: everything comes in as arguments, so the tests can try any setup.
 */
import path from "node:path";

export const APP_DIR_NAME = "schema-studio";

export type AppPaths = {
  /** Electron's profile and the small settings files. */
  config: string;
  /** The database and its keys. */
  data: string;
  /** The PostgreSQL folder inside `data`. */
  postgres: string;
  logs: string;
  configFile: string;
  authFile: string;
  secretsFile: string;
  /** The paired phones and the phone link's own keys (src/core/phone-link-file.ts). */
  phoneLinkFile: string;
};

/** The XDG folder from `value`, or the default under the home folder. */
function xdgHome(value: string | undefined, home: string, fallback: string): string {
  if (value && path.isAbsolute(value)) return value;
  return path.join(home, fallback);
}

export function resolveAppPaths(env: Record<string, string | undefined>, home: string): AppPaths {
  const config = path.join(xdgHome(env.XDG_CONFIG_HOME, home, ".config"), APP_DIR_NAME);
  const data = path.join(xdgHome(env.XDG_DATA_HOME, home, ".local/share"), APP_DIR_NAME);
  const state = path.join(xdgHome(env.XDG_STATE_HOME, home, ".local/state"), APP_DIR_NAME);
  return {
    config,
    data,
    postgres: path.join(data, "postgres"),
    logs: path.join(state, "logs"),
    configFile: path.join(config, "config.json"),
    authFile: path.join(config, "auth.json"),
    secretsFile: path.join(data, "secrets.json"),
    phoneLinkFile: path.join(config, "phone-link.json"),
  };
}

/**
 * A path as the app shows it to the person: the home folder written as ~, the
 * way a terminal does, so Settings and the error screens stay short and a
 * screenshot never spells out the login name. Only a whole folder name
 * counts, so /home/sam2 is not shown as ~2 for someone whose home is
 * /home/sam.
 */
export function displayPath(file: string, home: string): string {
  const base = home.replace(/\/+$/, "");
  // A home folder of / would turn every path into ~, which says nothing.
  if (base === "") return file;
  if (file === base) return "~";
  if (file.startsWith(base + "/")) return "~" + file.slice(base.length);
  return file;
}
