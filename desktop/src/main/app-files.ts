/**
 * Where the app's own files are, in one place.
 *
 * The pages, scripts and icons are inside app.asar, the read-only archive
 * electron-builder packs the app into. The server and the database are not:
 * PostgreSQL is a set of real programs, and the server runs in a separate
 * process that needs ordinary files, so scripts/after-pack.cjs puts both in
 * the install's resources folder, beside app.asar. A development run
 * (`npm start`) uses the same files straight from the desktop folder:
 * out/ from the TypeScript build, build/server from scripts/build-server.mjs
 * and build/postgres from scripts/fetch-postgres.mjs.
 */
import path from "node:path";
import { app } from "electron";

export type AppFiles = {
  /** app.asar, or the desktop folder in a development run. */
  root: string;
  /** splash.html, settings.html and app.css. */
  renderer: string;
  /** splash.js and settings.js, compiled from src/renderer. */
  rendererScripts: string;
  assets: string;
  appPreload: string;
  settingsPreload: string;
  buildConfig: string;
  /** The Next.js server: server.js, .next and node_modules. */
  serverDir: string;
  /** The script the server's process starts with (src/server/desktop-launcher.ts). */
  launcher: string;
  /** PostgreSQL's bin, lib and share folders. */
  postgresDir: string;
  /** The window icon. Electron can read it from inside app.asar. */
  icon: string;
  /**
   * The icon for About. Ubuntu's About dialog is drawn by GTK, which can only
   * read real files, so the packaged app has a copy outside app.asar.
   */
  aboutIcon: string;
};

export function appFiles(): AppFiles {
  const root = app.getAppPath();
  const packaged = app.isPackaged;
  const resources = process.resourcesPath;
  return {
    root,
    renderer: path.join(root, "renderer"),
    rendererScripts: path.join(root, "out", "renderer"),
    assets: path.join(root, "assets"),
    appPreload: path.join(root, "out", "preload", "app-preload.js"),
    settingsPreload: path.join(root, "out", "preload", "settings-preload.js"),
    buildConfig: path.join(root, "out", "build-config.json"),
    serverDir: packaged ? path.join(resources, "server") : path.join(root, "build", "server"),
    launcher: packaged
      ? path.join(resources, "server", "desktop-launcher.js")
      : path.join(root, "out", "server", "desktop-launcher.js"),
    postgresDir: packaged
      ? path.join(resources, "postgres")
      : path.join(root, "build", "postgres", `${process.platform}-${process.arch}`),
    icon: path.join(root, "assets", "icon.png"),
    aboutIcon: packaged ? path.join(resources, "icon.png") : path.join(root, "assets", "icon.png"),
  };
}
