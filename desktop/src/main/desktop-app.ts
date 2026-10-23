/**
 * The desktop app as a whole, from the moment Electron is ready until the
 * app quits.
 *
 * Starting takes four steps, and the splash shows each one:
 *
 * 1. secrets: unlock the app's keys, kept in Ubuntu's keyring.
 * 2. database: start the app's own PostgreSQL, where Schema Studio keeps its
 *    records.
 * 3. server: start Schema Studio's server, which only this computer can
 *    reach.
 * 4. sign-in: choose the first page. Someone still signed in goes straight
 *    to the studio; anyone else sees the sign-in page.
 *
 * If a step fails, the splash says what went wrong in plain words and
 * offers to try again, open the logs, or copy the details to share them.
 *
 * Once running, the Microsoft sign-in is checked again every six hours and
 * whenever the computer wakes up. If Microsoft says it has ended (the
 * account was disabled, say), the person is signed out. Without a network
 * the person stays signed in for up to 30 days after the last successful
 * check, which is what lets the app work offline.
 *
 * Quitting stops the server and then the database, cleanly, so nothing is
 * lost and nothing is left running.
 */
import crypto from "node:crypto";
import os from "node:os";

import {
  app,
  clipboard,
  dialog,
  Menu,
  powerMonitor,
  session,
  shell,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type Session,
  type WebContents,
} from "electron";

import { checkGithubSettings, readGithubSettingsInput } from "../core/github-settings";
import {
  decideAfterRecheck,
  RECHECK_INTERVAL_MS,
  withinOfflineWindow,
  type RecheckDecision,
  type RecheckOutcome,
} from "../core/offline";
import { displayPath, type AppPaths } from "../core/paths";
import { parsePhoneLinkState, type PhoneLinkState } from "../core/phone-link-file";
import { ensurePrivateDir, UnsafeDirError } from "../core/private-dir";
import { GATE_HEADER } from "../server/desktop-gate";
import {
  PHONE,
  STARTUP,
  type PhoneConnections,
  type SaveGithubResult,
  type SettingsView,
  type SignInResult,
  type StartupState,
  type StartupStep,
  type ThemeChoice,
} from "../shared/ipc";
import type { AppFiles } from "./app-files";
import { Auth } from "./auth";
import { versionLabel, type BuildInfo } from "./build-info";
import { ConfigStore } from "./config-store";
import { makeDiagnostics } from "./diagnostics";
import { findLocalDatabases } from "./finder";
import { registerIpc } from "./ipc";
import { addLogSecret, logError, logFolder, logInfo, logWarn } from "./log";
import { buildMenu } from "./menu";
import { openPhoneLink, type PhoneLink } from "./phone-link";
import type { AppAnswer } from "./phone-requests";
import { CONNECTIONS_FAILED, makePairing, phoneView, readPhoneConnections, setRelay } from "./phone-settings";
import { startPostgres, type RunningPostgres } from "./postgres";
import { APP_HOST, APP_ORIGIN, serveAppPages } from "./protocol";
import { keyringBackend, ProtectedStore } from "./secrets";
import { secureWindows } from "./security";
import type { RunningServer } from "./server";
import { StartupError } from "./startup-error";
import { openSecrets, startServerOnFreePort, type OpenedSecrets } from "./steps";
import { applyTheme, onThemeUpdated, windowBackground } from "./theme";
import { APP_PARTITION, createMainWindow, createSettingsWindow } from "./windows";

export type DesktopAppOptions = {
  files: AppFiles;
  paths: AppPaths;
  build: BuildInfo;
  /** Whether this is an installed copy, rather than one started from the source code. */
  packaged: boolean;
  /** The person's home folder, which Settings writes as "~". */
  home: string;
};

const START_FAILED_TITLE = "Schema Studio could not start";
const START_FAILED_MESSAGE =
  "Something went wrong while starting. Open the logs for details, or copy the details to share them.";
const STILL_STARTING = "Schema Studio is still starting. Try again in a moment.";
const SAVE_FAILED = "Schema Studio could not save the settings. Open the logs for details.";
/** How long the first page waits for Microsoft, when the sign-in must be checked before the studio may open. */
const FIRST_CHECK_MS = 20_000;
/** How long a check in the background waits for Microsoft. */
const BACKGROUND_CHECK_MS = 30_000;
/** How long Settings waits for the server to list the saved connections that phones may be shown. */
const PHONE_CONNECTIONS_MS = 15_000;
const PHONE_LINK_FAILED = "The phone link could not start. Schema Studio's log has the details.";
/** How long quitting waits for the server and the database to stop before the app stops anyway. */
const QUIT_LIMIT_MS = 20_000;
/** How long to wait, after the server or the database stops, before saying so. A start failing because of it explains itself on the splash in that time. */
const STOPPED_NOTICE_DELAY_MS = 1_000;

type SignOutReason = Extract<RecheckDecision, { action: "sign-out" }>["reason"];

/** Whether loadURL gave up because another page was loaded before it finished (ERR_ABORTED), which is expected. */
function wasInterrupted(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errno" in error && error.errno === -3;
}

/** Whether `url` is the app's own page `page`, such as "/splash.html". */
function isAppPage(url: string, page: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "app:" && parsed.host === APP_HOST && parsed.pathname === page;
  } catch {
    return false;
  }
}

function liveContents(window: BrowserWindow | null): WebContents | null {
  return window === null || window.isDestroyed() ? null : window.webContents;
}

/** Settles as `promise` does, unless `signal` is aborted first: then it rejects with the signal's reason. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    // Listened to either way, so a late failure is never left unhandled.
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The settings file. If its folder cannot be used, the settings last until
 * the app quits. The secrets step uses the same folder, so the splash then
 * says what is wrong with it.
 */
function openConfig(paths: AppPaths): ConfigStore {
  try {
    ensurePrivateDir(paths.config);
    return new ConfigStore(paths.configFile);
  } catch (error) {
    logWarn(`Schema Studio cannot keep its settings in ${paths.config}, so they last until it quits.`, error);
    return new ConfigStore(null);
  }
}

function logSignOut(reason: SignOutReason): void {
  logInfo(
    reason === "SessionRevoked"
      ? "Microsoft says the sign-in has ended, so Schema Studio signed out."
      : "The sign-in could not be confirmed with Microsoft for 30 days, so Schema Studio signed out.",
  );
}

export class DesktopApp {
  private readonly files: AppFiles;
  private readonly paths: AppPaths;
  private readonly build: BuildInfo;
  private readonly packaged: boolean;
  private readonly home: string;
  /** Proves to the server that a request comes from this app's own windows. A new one every time the app starts. */
  private readonly gateToken = crypto.randomBytes(32).toString("base64url");
  private readonly config: ConfigStore;
  /** The Appearance choice in use. It still applies for now when saving it failed. */
  private theme: ThemeChoice;
  /** Aborted when the app quits, which stops whatever step of starting is under way. */
  private readonly stopStarting = new AbortController();
  private ses: Session | null = null;
  private opened: OpenedSecrets | null = null;
  private auth: Auth | null = null;
  private postgres: RunningPostgres | null = null;
  private server: RunningServer | null = null;
  /** The phone link, once it has opened and started. */
  private phoneLink: PhoneLink | null = null;
  /** Why the phone link could not open or start, for Settings. */
  private phoneLinkProblem: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private settingsWindow: BrowserWindow | null = null;
  private startup: StartupState = { phase: "starting", step: "secrets" };
  private startupRun: Promise<void> = Promise.resolve();
  /** Whether starting got as far as the first page. */
  private started = false;
  /** What happened when the database or the server stopped unexpectedly, for the diagnostics. */
  private databaseGone: string | null = null;
  private serverGone: string | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private rechecking = false;
  private quitting = false;
  private cleaning: Promise<void> | null = null;
  private cleanedUp = false;
  private stoppedNoticeShown = false;

  constructor(options: DesktopAppOptions) {
    this.files = options.files;
    this.paths = options.paths;
    this.build = options.build;
    this.packaged = options.packaged;
    this.home = options.home;
    addLogSecret(this.gateToken);
    this.config = openConfig(options.paths);
    this.theme = this.config.get().theme;
  }

  /** Opens the window, shows the splash and starts the app. Called once, when Electron is ready. */
  start(): void {
    applyTheme(this.theme);
    app.setAboutPanelOptions({
      applicationName: "Schema Studio",
      applicationVersion: versionLabel(this.build),
      copyright: "© 2026 the Schema Studio team",
      authors: ["Schema Studio team"],
      website: "https://github.com/UmerNaseer2/FYP",
      iconPath: this.files.aboutIcon,
    });
    this.registerMessages();

    const ses = session.fromPartition(APP_PARTITION);
    this.ses = ses;
    serveAppPages(ses, this.files);
    secureWindows(ses, {
      serverOrigin: () => this.server?.origin ?? null,
      gateToken: this.gateToken,
      isMainWindow: (contents) => contents === liveContents(this.mainWindow),
      openExternal: (url) => {
        shell.openExternal(url).catch((error: unknown) => logWarn("Could not open a link in the web browser.", error));
      },
    });

    this.watchQuitting();
    onThemeUpdated(() => {
      // The color a window shows before its page draws, and around it while it resizes.
      const color = windowBackground();
      for (const window of [this.mainWindow, this.settingsWindow]) {
        if (window !== null && !window.isDestroyed()) window.setBackgroundColor(color);
      }
    });
    // A sign-in can end while the computer sleeps.
    powerMonitor.on("resume", () => {
      void this.recheckNow();
    });
    app.on("child-process-gone", (_event, details) => {
      if (details.reason !== "clean-exit") logWarn(`A ${details.type} process stopped (${details.reason}).`);
    });

    this.refreshMenu();
    this.openMainWindow();
    this.startupRun = this.runStartup().catch((error: unknown) => logError("Starting went wrong unexpectedly.", error));
  }

  /** Brings the main window to the front, as when Schema Studio is opened again while it runs. */
  focusWindow(): void {
    const window = this.mainWindow;
    if (window === null || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private registerMessages(): void {
    registerIpc({
      mainContents: () => liveContents(this.mainWindow),
      settingsContents: () => liveContents(this.settingsWindow),
      serverOrigin: () => this.server?.origin ?? null,
      bridge: {
        signIn: () => this.signIn(),
        cancelSignIn: () => this.auth?.cancelSignIn(),
        signOut: () => this.endSession("/login"),
        findLocalDatabases: () => findLocalDatabases(),
        setTheme: (choice) => this.setTheme(choice),
        openSettings: () => this.openSettings(),
      },
      startup: {
        getState: () => this.startup,
        retry: () => this.retry(),
        openLogs: () => void this.openLogs(),
        copyDetails: () => this.copyDetails(),
      },
      settings: {
        get: () => this.settingsView(),
        saveGithub: (input) => this.saveGithub(input),
        setTheme: (choice) => this.setTheme(choice),
        openLogs: () => void this.openLogs(),
        close: () => this.settingsWindow?.close(),
      },
      phone: {
        get: () => phoneView(this.phoneLink, this.phoneLinkProblem),
        setEnabled: (enabled) => this.phoneLink?.setEnabled(enabled),
        setRelay: (origin) => setRelay(this.phoneLink, origin, this.phoneLinkProblem),
        setShared: (ids) => this.phoneLink?.setSharedConnections(ids),
        forget: (key) => this.phoneLink?.forgetPhone(key),
        pair: () => makePairing(this.phoneLink, this.phoneLinkProblem),
        cancelPairing: () => this.phoneLink?.cancelPairing(),
        connectNow: () => this.phoneLink?.connectNow(),
        connections: () => this.phoneConnections(),
      },
    });
  }

  private openMainWindow(): void {
    const window = createMainWindow({
      files: this.files,
      saved: this.config.get().window,
      packaged: this.packaged,
      saveWindow: (saved) => {
        this.config.save({ ...this.config.get(), window: saved });
      },
    });
    this.mainWindow = window;
    window.on("closed", () => {
      this.mainWindow = null;
    });
    const contents = window.webContents;
    contents.on("render-process-gone", (_event, details) => this.windowGone(details.reason));
    contents.on("unresponsive", () => logWarn("The window stopped responding."));
    contents.on("responsive", () => logInfo("The window is responding again."));
    contents.on("preload-error", (_event, _file, error) => logError("The window's preload script failed.", error));
    this.showSplash();
  }

  // Starting

  private async runStartup(): Promise<void> {
    const { signal } = this.stopStarting;
    try {
      this.setStep("secrets");
      const opened = openSecrets(this.paths, true);
      for (const secret of [opened.secrets.nextauthSecret, opened.secrets.appEncryptionKey, opened.secrets.githubToken]) {
        if (secret !== null) addLogSecret(secret);
      }
      this.opened = opened;
      const auth = new Auth({
        config: this.build,
        state: opened.authState,
        // Auth logs a failure to save. The sign-in then lasts until the app quits.
        save: (state) => {
          opened.authStore.save(state);
        },
        focusWindow: () => this.focusWindow(),
      });
      this.auth = auth;
      this.refreshMenu();

      this.setStep("database");
      const postgres = await startPostgres({ installDir: this.files.postgresDir, paths: this.paths, signal });
      this.postgres = postgres;
      postgres.onUnexpectedExit((description) => this.stoppedUnexpectedly("database", description));

      this.setStep("server");
      const server = await startServerOnFreePort({
        files: this.files,
        config: this.config,
        socketDir: postgres.socketDir,
        buildConfig: this.build,
        secrets: opened.secrets,
        gateToken: this.gateToken,
        signal,
      });
      this.server = server;
      server.onUnexpectedExit((description) => this.stoppedUnexpectedly("server", description));

      this.setStep("sign-in");
      const first = await this.firstPage(auth, signal);
      await this.loadServerPage(first.page);
      this.started = true;
      logInfo("Schema Studio is ready.");
      this.startRechecks(!first.checked);
      // Never throws: a phone link that cannot start is logged, and the rest of the app carries on without it.
      await this.startPhoneLink();
    } catch (error) {
      // Quitting stopped the step under way, which is not a failure to report.
      if (signal.aborted) return;
      this.fail(error);
    }
  }

  private setStep(step: StartupStep): void {
    this.startup = { phase: "starting", step };
    this.pushStartup();
  }

  /** Tells the splash, if it is showing, how starting is going. A splash still loading asks by itself. */
  private pushStartup(): void {
    this.splashContents()?.send(STARTUP.status, this.startup);
  }

  private splashContents(): WebContents | null {
    const contents = liveContents(this.mainWindow);
    return contents !== null && isAppPage(contents.getURL(), "/splash.html") ? contents : null;
  }

  private showSplash(): void {
    const contents = liveContents(this.mainWindow);
    if (contents === null) return;
    contents.loadURL(`${APP_ORIGIN}/splash.html`).catch((error: unknown) => {
      if (!wasInterrupted(error)) logError("Could not show the splash.", error);
    });
  }

  /** Shows on the splash why starting failed. */
  private fail(error: unknown): void {
    let title = START_FAILED_TITLE;
    let message = START_FAILED_MESSAGE;
    if (error instanceof StartupError) {
      title = error.title;
      message = error.message;
    } else if (error instanceof UnsafeDirError) {
      message = error.message;
    }
    logError(`${title}. ${message}`, error);
    this.startup = { phase: "failed", title, message };
    // The window may be showing a server page that failed to load, rather than the splash.
    if (this.splashContents() !== null) this.pushStartup();
    else this.showSplash();
  }

  /** "Try again" on the splash: a fresh start is the surest way to clear whatever went wrong. */
  private retry(): void {
    if (this.startup.phase !== "failed" || this.quitting) return;
    logInfo("Starting again, as asked.");
    app.relaunch();
    app.quit();
  }

  // The Microsoft sign-in

  /**
   * The page the window opens on, and whether Microsoft was already asked
   * about the sign-in on the way.
   *
   * Someone still signed in goes straight to the studio, and the sign-in is
   * then checked in the background. Only when the last successful check is
   * 30 days old or more does the studio wait for Microsoft first, since the
   * answer then decides whether the person may stay signed in at all.
   */
  private async firstPage(auth: Auth, signal: AbortSignal): Promise<{ page: string; checked: boolean }> {
    if (!auth.configured) return { page: "/login", checked: true };
    if (!(await auth.hasAccount())) {
      // A cookie left from an earlier sign-in does not count without the Microsoft sign-in behind it.
      await this.clearSessionCookies();
      return { page: "/login", checked: true };
    }
    if (withinOfflineWindow(auth.lastOnlineCheck(), Date.now())) return { page: "/studio", checked: false };
    const outcome = await this.checkSignIn(auth, FIRST_CHECK_MS, signal);
    const decision = decideAfterRecheck(outcome, auth.lastOnlineCheck(), Date.now());
    if (decision.action === "keep") return { page: "/studio", checked: true };
    logSignOut(decision.reason);
    await auth.signOut();
    await this.clearSessionCookies();
    return { page: `/login?error=${decision.reason}`, checked: true };
  }

  /** Asks Microsoft whether the sign-in still stands. Getting no answer at all counts as Microsoft being unavailable. */
  private async checkSignIn(auth: Auth, timeoutMs: number, signal: AbortSignal): Promise<RecheckOutcome> {
    try {
      return await unlessAborted(auth.recheck(timeoutMs), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      logWarn("Could not check the Microsoft sign-in.", error);
      return "unavailable";
    }
  }

  /** Checks the sign-in again every six hours from now on, and straight away as well when `now` is true. */
  private startRechecks(now: boolean): void {
    if (this.auth === null || !this.auth.configured) return;
    this.recheckTimer = setInterval(() => {
      void this.recheckNow();
    }, RECHECK_INTERVAL_MS);
    if (now) void this.recheckNow();
  }

  /** Checks the Microsoft sign-in in the background, and signs the person out if it no longer stands. */
  private async recheckNow(): Promise<void> {
    const { auth } = this;
    if (auth === null || !auth.configured || !this.started || this.quitting || this.rechecking) return;
    this.rechecking = true;
    try {
      if (!(await auth.hasAccount())) return;
      const outcome = await this.checkSignIn(auth, BACKGROUND_CHECK_MS, this.stopStarting.signal);
      const decision = decideAfterRecheck(outcome, auth.lastOnlineCheck(), Date.now());
      if (decision.action === "sign-out" && !this.quitting) {
        logSignOut(decision.reason);
        await this.endSession(`/login?error=${decision.reason}`);
      }
    } catch (error) {
      if (!this.quitting) logWarn("Could not check the Microsoft sign-in.", error);
    } finally {
      this.rechecking = false;
    }
  }

  private async signIn(): Promise<SignInResult> {
    const { auth } = this;
    if (auth === null) return { ok: false, reason: "failed", message: STILL_STARTING };
    return auth.signIn();
  }

  /** Signs out of Microsoft and of Schema Studio, then shows `page`. */
  private async endSession(page: string): Promise<void> {
    await this.auth?.signOut();
    await this.clearSessionCookies();
    await this.loadServerPage(page);
  }

  /** Removes Schema Studio's sign-in cookie, and saves that at once, so it is gone even if the app is then killed. */
  private async clearSessionCookies(): Promise<void> {
    const { ses } = this;
    if (ses === null) return;
    try {
      await ses.clearStorageData({ storages: ["cookies"] });
      await ses.cookies.flushStore();
    } catch (error) {
      logWarn("Could not remove the sign-in cookie.", error);
    }
  }

  private async loadServerPage(page: string): Promise<void> {
    const contents = liveContents(this.mainWindow);
    const origin = this.server?.origin;
    if (contents === null || origin === undefined) return;
    try {
      await contents.loadURL(origin + page);
    } catch (error) {
      if (!wasInterrupted(error)) throw error;
    }
    // Back must not lead to the splash, or to a page from before signing out.
    contents.navigationHistory.clear();
  }

  // The phone link

  /** Opens the phone link and starts it. It answers phones through the server, so it starts once the server is up. */
  private async startPhoneLink(): Promise<void> {
    try {
      const opening = await openPhoneLink({
        store: new ProtectedStore<PhoneLinkState>({
          file: this.paths.phoneLinkFile,
          what: "the phone link's keys",
          parse: parsePhoneLinkState,
          allowKeyring: true,
        }),
        fileLabel: displayPath(this.paths.phoneLinkFile, this.home),
        call: (method, path, body, signal) => this.callServer(method, path, body, signal),
        appVersion: app.getVersion(),
        computerName: os.hostname(),
        onChange: () => this.phoneChanged(),
        onPaired: (phone) => liveContents(this.settingsWindow)?.send(PHONE.paired, phone.name),
      });
      if (!opening.ok) {
        logWarn(`The phone link is unavailable: ${opening.reason}`);
        this.phoneLinkProblem = opening.reason;
        this.phoneChanged();
        return;
      }
      // The app began quitting while the keys were opening.
      if (this.quitting) return;
      opening.link.start();
      // Kept once it has started, so that Settings says why if starting fails.
      this.phoneLink = opening.link;
      this.phoneChanged();
    } catch (error) {
      logError("The phone link could not start.", error);
      this.phoneLinkProblem = PHONE_LINK_FAILED;
      this.phoneChanged();
    }
  }

  /** Tells Settings, if it is open, how the phone link stands now. */
  private phoneChanged(): void {
    liveContents(this.settingsWindow)?.send(PHONE.changed, phoneView(this.phoneLink, this.phoneLinkProblem));
  }

  /** The saved connections, for Settings to choose which ones phones may see. The server lists them for whoever is signed in. */
  private async phoneConnections(): Promise<PhoneConnections> {
    if (this.server === null) return { ok: false, message: STILL_STARTING };
    try {
      return readPhoneConnections(
        await this.callServer("GET", "/api/connections/phone", undefined, AbortSignal.timeout(PHONE_CONNECTIONS_MS)),
      );
    } catch (error) {
      logWarn("Could not list the saved connections for the phone link.", error);
      return { ok: false, message: CONNECTIONS_FAILED };
    }
  }

  /**
   * Asks the app's own server, for a phone's request. It asks as the window
   * does, with the window's sign-in cookie, so a phone sees only what the
   * person signed in here may see.
   */
  private async callServer(method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal): Promise<AppAnswer> {
    const { ses, server } = this;
    if (ses === null || server === null) throw new Error("Schema Studio's server is not running.");
    // The token that lets a request through to the server (src/server/desktop-gate.ts). The request hook in
    // security.ts puts it on every request to the server as well; it is set here too so that this call does not
    // lean on that.
    const headers: Record<string, string> = { [GATE_HEADER]: this.gateToken };
    if (method === "POST") headers["content-type"] = "application/json";
    const response = await ses.fetch(server.origin + path, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      // The sign-in cookie lives in this session, which the window shares.
      credentials: "include",
      // The routes a phone asks for answer directly. A redirect, such as to the sign-in page, is no answer to pass on.
      redirect: "error",
      cache: "no-store",
      signal,
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch (error) {
      // A body that is not JSON, such as an error page, leaves json null. A phone that gave up is passed on as it is.
      if (signal.aborted) throw error;
    }
    return { status: response.status, json };
  }

  // When something stops

  /** The database or the server stopped while the app was using it. */
  private stoppedUnexpectedly(what: "database" | "server", description: string): void {
    if (what === "database") this.databaseGone = description;
    else this.serverGone = description;
    logError(`The ${what} stopped unexpectedly: ${description}`);
    setTimeout(() => {
      if (this.quitting || this.startup.phase === "failed" || this.stoppedNoticeShown) return;
      this.stoppedNoticeShown = true;
      void this.noticeStopped(what);
    }, STOPPED_NOTICE_DELAY_MS);
  }

  private async noticeStopped(what: "database" | "server"): Promise<void> {
    const options: MessageBoxOptions = {
      type: "error",
      title: "Schema Studio stopped",
      message:
        what === "database" ? "Schema Studio's database stopped unexpectedly." : "Schema Studio stopped working unexpectedly.",
      detail: "Restart Schema Studio to carry on. Anything you had not saved may be lost. The logs say what happened.",
      buttons: ["Restart", "Open Logs", "Quit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    for (;;) {
      const { response } = await this.messageBox(options);
      if (this.quitting) return;
      if (response === 1) {
        // The question comes back once the logs are open.
        await this.openLogs();
        continue;
      }
      if (response === 0) app.relaunch();
      app.quit();
      return;
    }
  }

  /** The window's page stopped, from a crash or from running out of memory. */
  private windowGone(reason: string): void {
    if (reason === "clean-exit" || this.quitting) return;
    logError(`The window stopped working (${reason}).`);
    void this.offerReload();
  }

  private async offerReload(): Promise<void> {
    const { response } = await this.messageBox({
      type: "error",
      title: "Schema Studio",
      message: "Schema Studio's window stopped working.",
      detail: "Reload it to carry on. Anything you had not saved is lost.",
      buttons: ["Reload", "Quit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (this.quitting) return;
    if (response === 0) liveContents(this.mainWindow)?.reload();
    else app.quit();
  }

  /** A message box on top of the main window, or on its own when the window has closed. */
  private messageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
    const window = this.mainWindow;
    return window !== null && !window.isDestroyed()
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options);
  }

  // Quitting

  private watchQuitting(): void {
    app.on("before-quit", () => {
      this.quitting = true;
    });
    // Electron would quit right after this. It waits instead until the server and the database have stopped.
    app.on("will-quit", (event) => {
      if (this.cleanedUp) return;
      event.preventDefault();
      this.cleaning ??= this.cleanUp();
    });
    // Ubuntu is shutting down or logging out. Asking it to wait lets the database stop cleanly first.
    powerMonitor.on("shutdown", (event?: { preventDefault(): void }) => {
      event?.preventDefault();
      app.quit();
    });
  }

  private async cleanUp(): Promise<void> {
    this.quitting = true;
    const hardStop = setTimeout(() => {
      logWarn("Schema Studio took too long to stop, so it stopped without waiting any longer.");
      app.exit(0);
    }, QUIT_LIMIT_MS);
    this.stopStarting.abort(new Error("Schema Studio is quitting."));
    if (this.recheckTimer !== null) clearInterval(this.recheckTimer);
    this.auth?.cancelSignIn();
    this.phoneLink?.stop();
    // Never rejects. Waiting for it means a database still starting is known about, and stopped below.
    await this.startupRun;
    const { server, postgres } = this;
    if (server !== null) {
      try {
        await server.stop();
      } catch (error) {
        logWarn("The server did not stop cleanly.", error);
      }
    }
    if (postgres !== null) {
      try {
        await postgres.stop();
      } catch (error) {
        logWarn("The database did not stop cleanly.", error);
      }
    }
    try {
      await this.ses?.cookies.flushStore();
    } catch (error) {
      logWarn("Could not save the cookies.", error);
    }
    clearTimeout(hardStop);
    logInfo("Schema Studio stopped.");
    this.cleanedUp = true;
    app.exit(0);
  }

  // Settings, the menu and Help

  private openSettings(): void {
    const parent = this.mainWindow;
    if (this.opened === null || parent === null || parent.isDestroyed()) return;
    const open = this.settingsWindow;
    if (open !== null && !open.isDestroyed()) {
      open.focus();
      return;
    }
    const window = createSettingsWindow(parent, this.files, this.packaged);
    this.settingsWindow = window;
    window.on("closed", () => {
      if (this.settingsWindow === window) this.settingsWindow = null;
      // A code shown in Settings must not pair a phone once Settings has closed.
      this.phoneLink?.cancelPairing();
    });
  }

  private settingsView(): SettingsView {
    const { opened } = this;
    if (opened === null) throw new Error(STILL_STARTING);
    const { github } = this.config.get();
    return {
      github: { owner: github.owner, repo: github.repo, hasToken: opened.secrets.githubToken !== null },
      theme: this.theme,
      secretsKeptIn: opened.protection === "keyring" ? "keyring" : "file",
      paths: {
        data: displayPath(this.paths.data, this.home),
        logs: displayPath(logFolder() ?? this.paths.logs, this.home),
      },
      version: versionLabel(this.build),
    };
  }

  /** Saves the GitHub registry and token from Settings, and passes them to the server, which uses them from then on. */
  private saveGithub(raw: unknown): SaveGithubResult {
    const { opened } = this;
    if (opened === null) return { ok: false, field: null, message: STILL_STARTING };
    const input = readGithubSettingsInput(raw);
    if (input === null) {
      return { ok: false, field: null, message: "Schema Studio could not read what was entered. Close Settings and try again." };
    }
    const check = checkGithubSettings(input);
    if (!check.ok) return { ok: false, field: check.field, message: check.message };
    const { change } = check;

    // The token goes in the keyring first: the server must never have a token that was not saved.
    if (change.token !== undefined) {
      const next = { ...opened.secrets, githubToken: change.token };
      try {
        opened.protection = opened.store.save(next);
      } catch (error) {
        logError("Could not save the GitHub token.", error);
        return { ok: false, field: null, message: SAVE_FAILED };
      }
      opened.secrets = next;
      if (change.token !== null) addLogSecret(change.token);
    }
    const saved = this.config.save({ ...this.config.get(), github: { owner: change.owner, repo: change.repo } });
    // Whatever was saved, the server gets it, even when the registry could not be saved.
    this.sendGithub();
    if (!saved) return { ok: false, field: null, message: SAVE_FAILED };
    return { ok: true, view: this.settingsView() };
  }

  private sendGithub(): void {
    const { opened, server } = this;
    if (opened === null || server === null) return;
    const { owner, repo } = this.config.get().github;
    server.sendGithub(owner, repo, opened.secrets.githubToken);
  }

  private setTheme(choice: ThemeChoice): void {
    this.theme = choice;
    // ConfigStore logs a failure to save. The choice still applies until the app quits.
    this.config.save({ ...this.config.get(), theme: choice });
    applyTheme(choice);
    this.refreshMenu();
  }

  private async openLogs(): Promise<void> {
    const folder = logFolder() ?? this.paths.logs;
    let problem: string;
    try {
      // An empty answer means it worked.
      problem = await shell.openPath(folder);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem === "") return;
    logWarn(`Could not open the logs folder: ${problem}`);
    await this.messageBox({
      type: "warning",
      title: "Schema Studio",
      message: "Schema Studio could not open the logs folder.",
      detail: `The logs are in ${displayPath(folder, this.home)}.`,
      buttons: ["OK"],
      noLink: true,
    });
  }

  private refreshMenu(): void {
    Menu.setApplicationMenu(
      buildMenu(
        { packaged: this.packaged, settingsAvailable: this.opened !== null, theme: this.theme },
        {
          openSettings: () => this.openSettings(),
          setTheme: (choice) => this.setTheme(choice),
          openLogs: () => void this.openLogs(),
          copyDiagnostics: () => void this.copyDiagnosticsFromMenu(),
          showAbout: () => app.showAboutPanel(),
        },
      ),
    );
  }

  private statusLines(): [string, string][] {
    const { startup, server, auth } = this;
    let progress: string;
    if (startup.phase === "failed") progress = `failed: ${startup.title}. ${startup.message}`;
    else if (this.started) progress = "finished";
    else progress = `at the "${startup.step}" step`;
    let signIn: string;
    if (auth === null) signIn = "not opened yet";
    else if (!auth.configured) signIn = "not set up in this build";
    else {
      const last = auth.lastOnlineCheck();
      signIn = last === null ? "not confirmed with Microsoft yet" : `last confirmed with Microsoft ${new Date(last).toISOString()}`;
    }
    let database = this.postgres === null ? "not started" : "running";
    if (this.databaseGone !== null) database = `stopped unexpectedly: ${this.databaseGone}`;
    let serverState = server === null ? "not started" : `running on port ${server.port}`;
    if (this.serverGone !== null) serverState = `stopped unexpectedly: ${this.serverGone}`;
    return [
      ["Starting", progress],
      ["Database", database],
      ["Server", serverState],
      ["Microsoft sign-in", signIn],
      ["Appearance", this.theme],
    ];
  }

  private async copyDiagnostics(): Promise<void> {
    const { opened } = this;
    let secretsKeptIn: "keyring" | "file" | null = null;
    if (opened !== null) secretsKeptIn = opened.protection === "keyring" ? "keyring" : "file";
    await clipboard.writeText(
      makeDiagnostics({
        build: this.build,
        version: versionLabel(this.build),
        packaged: this.packaged,
        paths: this.paths,
        secretsKeptIn,
        keyringBackend: keyringBackend(),
        status: this.statusLines(),
      }),
    );
  }

  /** Help > Copy Diagnostics, which says how it went. */
  private async copyDiagnosticsFromMenu(): Promise<void> {
    try {
      await this.copyDiagnostics();
    } catch (error) {
      logError("Could not copy the diagnostics.", error);
      await this.messageBox({
        type: "error",
        title: "Schema Studio",
        message: "Schema Studio could not copy the diagnostics.",
        detail: "Open the logs for details.",
        buttons: ["OK"],
        noLink: true,
      });
      return;
    }
    await this.messageBox({
      type: "info",
      title: "Schema Studio",
      message: "The diagnostics are on the clipboard.",
      detail:
        "Paste them into an email or a message to share them. Passwords, keys and your email address have been removed.",
      buttons: ["OK"],
      noLink: true,
    });
  }

  /** "Copy details" on the splash, which says how it went itself. */
  private async copyDetails(): Promise<void> {
    try {
      await this.copyDiagnostics();
    } catch (error) {
      logError("Could not copy the details.", error);
      throw new Error("Schema Studio could not copy the details.");
    }
  }
}
