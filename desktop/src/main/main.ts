/**
 * Where the desktop app begins.
 *
 * Before Electron is ready, this prepares: it decides where the app keeps
 * its files, makes sure only one copy runs, and takes PostgreSQL settings
 * out of the environment, so the person's own (PGHOST, PGPASSWORD and the
 * like) can never reach the app's database. Once Electron is ready, it
 * either runs the self-test (`schema-studio --self-test`, used by the
 * install tests) or hands over to DesktopApp. The start-at-sign-in file
 * starts it with --background (src/core/autostart.ts), which with Keep
 * running on leaves the window hidden.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app, dialog } from "electron";

import { BACKGROUND_FLAG } from "../core/autostart";
import { resolveAppPaths } from "../core/paths";
import { appFiles } from "./app-files";
import { readBuildInfo, versionLabel } from "./build-info";
import { DesktopApp } from "./desktop-app";
import { initLog, logError, logInfo } from "./log";
import { registerAppScheme } from "./protocol";
import { runSelfTest } from "./self-test";

/**
 * Run as root, the app would leave files in the person's folders that only
 * root can change, and their next normal start would fail. So it stops
 * before it writes anything. Chromium usually refuses to run as root even
 * earlier; this covers the cases where it does not.
 */
if (process.getuid?.() === 0) {
  process.stderr.write("Schema Studio cannot run as root (administrator). Open it as your normal user.\n");
  process.exit(1);
}

const selfTest = process.argv.includes("--self-test");
/** Started at sign-in by the start-at-sign-in file, rather than by someone opening it. */
const background = process.argv.includes(BACKGROUND_FLAG);

for (const name of Object.keys(process.env)) {
  if (name.startsWith("PG")) delete process.env[name];
}

/** Folders of the self-test's own, so it never touches the person's files. They are removed when it ends. */
function makeSelfTestFolders(): string {
  // /tmp rather than os.tmpdir(), because the path of the database's socket has to stay short.
  const root = fs.mkdtempSync(path.join("/tmp", "ss-test-"));
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  // Under runuser it can still name the other account's folder.
  delete process.env.XDG_RUNTIME_DIR;
  return root;
}

const selfTestRoot = selfTest ? makeSelfTestFolders() : null;
const paths = resolveAppPaths(process.env, os.homedir());
// Chromium's own files (the cookie store and caches) go with the app's
// settings, rather than in a separate "~/.config/Schema Studio".
app.setPath("userData", paths.config);
app.setPath("sessionData", paths.config);
app.setAppLogsPath(paths.logs);

let desktop: DesktopApp | null = null;

/**
 * Whether a second copy, from what it sent along, was started at sign-in.
 * It finds this copy already running, say because the person opened Schema
 * Studio before the sign-in got round to starting it, and then it should
 * not bring a window up that nobody asked for.
 */
function startedInBackground(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { background?: unknown }).background === true;
}

async function ready(): Promise<void> {
  initLog(paths.logs, { echo: !app.isPackaged || selfTest });
  const files = appFiles();
  const build = readBuildInfo(files);
  logInfo(`Schema Studio ${versionLabel(build)} is starting${selfTest ? " its self-test" : ""}.`);
  if (selfTestRoot !== null) {
    let code = 1;
    try {
      code = await runSelfTest(files, paths, build);
    } finally {
      fs.rmSync(selfTestRoot, { recursive: true, force: true });
    }
    app.exit(code);
    return;
  }
  desktop = new DesktopApp({ files, paths, build, packaged: app.isPackaged, home: os.homedir(), background });
  desktop.start();
}

if (!selfTest && !app.requestSingleInstanceLock({ background })) {
  // Schema Studio is already open. That copy brings its window to the front,
  // unless this one was started at sign-in.
  app.quit();
} else {
  registerAppScheme();
  app.enableSandbox();
  process.on("SIGTERM", () => app.quit());
  process.on("SIGINT", () => app.quit());
  process.on("unhandledRejection", (reason) => logError("Something went wrong in the background.", reason));
  app.on("window-all-closed", () => app.quit());
  app.on("second-instance", (_event, _argv, _workingDirectory, data) => {
    if (!startedInBackground(data)) desktop?.focusWindow();
  });
  app
    .whenReady()
    .then(ready)
    .catch((error: unknown) => {
      logError("Schema Studio could not start.", error);
      if (!selfTest) {
        dialog.showErrorBox("Schema Studio could not start", "Something went wrong while starting. The logs say what happened.");
      }
      app.exit(1);
    });
}
