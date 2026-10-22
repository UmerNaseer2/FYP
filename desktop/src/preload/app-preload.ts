/**
 * The preload script of the main window: what the window's pages may ask
 * the main process to do.
 *
 * The main window shows two kinds of page. While the app starts, it shows
 * the splash (app://schema-studio/splash.html), which may ask how the start
 * is going, start again, open the logs and copy the details. Once the app's
 * server is running, it shows Schema Studio itself, from
 * http://127.0.0.1:<port>, which may use the desktop features: signing in
 * with Microsoft, finding local databases, changing the theme and opening
 * Settings. Electron runs this script again for every page the window
 * loads, so each page gets only its own set. Any other page gets nothing.
 *
 * This is the first of two locks. The main process checks every message
 * again before it acts on it (src/main/ipc.ts), down to the exact address
 * of the app's server, which this script cannot know.
 *
 * The window is sandboxed, so this has to be one plain script that loads
 * nothing but Electron. That is why it has no imports and repeats the
 * message names from src/shared/ipc.ts; the types make the compiler check
 * each one against the original. Each function passes on only what it
 * names, and Electron's own message event never reaches a page, because a
 * page could use it to send messages of its own choosing.
 */
{
  const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
  type Ipc = typeof import("../shared/ipc");

  const BRIDGE: Ipc["BRIDGE"] = {
    signIn: "desktop:sign-in",
    cancelSignIn: "desktop:cancel-sign-in",
    signOut: "desktop:sign-out",
    findLocalDatabases: "desktop:find-local-databases",
    setTheme: "desktop:set-theme",
    openSettings: "desktop:open-settings",
  };
  const STARTUP: Ipc["STARTUP"] = {
    getState: "startup:get-state",
    status: "startup:status",
    retry: "startup:retry",
    openLogs: "startup:open-logs",
    copyDetails: "startup:copy-details",
  };

  const here = new URL(location.href);

  if (here.protocol === "app:" && here.host === "schema-studio" && here.pathname === "/splash.html") {
    const startup: import("../shared/ipc").StartupApi = {
      getState: () => ipcRenderer.invoke(STARTUP.getState),
      onStatus: (listener) => {
        ipcRenderer.on(STARTUP.status, (_event, state) => listener(state));
      },
      retry: () => ipcRenderer.send(STARTUP.retry),
      openLogs: () => ipcRenderer.send(STARTUP.openLogs),
      copyDetails: () => ipcRenderer.invoke(STARTUP.copyDetails),
    };
    contextBridge.exposeInMainWorld("schemaStudioStartup", startup);
  } else if (here.protocol === "http:" && here.hostname === "127.0.0.1") {
    const desktop: import("../shared/bridge").DesktopBridge = {
      signIn: () => ipcRenderer.invoke(BRIDGE.signIn),
      cancelSignIn: () => ipcRenderer.send(BRIDGE.cancelSignIn),
      signOut: () => ipcRenderer.invoke(BRIDGE.signOut),
      findLocalDatabases: () => ipcRenderer.invoke(BRIDGE.findLocalDatabases),
      setTheme: (choice) => ipcRenderer.send(BRIDGE.setTheme, choice),
      openSettings: () => ipcRenderer.send(BRIDGE.openSettings),
    };
    contextBridge.exposeInMainWorld("schemaStudioDesktop", desktop);
  }
}
