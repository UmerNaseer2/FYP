/**
 * The preload script of the Settings window: what the Settings page may ask
 * the main process to do.
 *
 * Only app://schema-studio/settings.html gets anything. It may read the
 * settings, save the GitHub registry, change the theme, open the logs and
 * close the window. As in the main window's preload (app-preload.ts), the
 * main process checks every message again before it acts on it, the message
 * names are repeated here because a sandboxed preload can load nothing but
 * Electron, and the types make the compiler check them against
 * src/shared/ipc.ts.
 */
{
  const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
  type Ipc = typeof import("../shared/ipc");

  const SETTINGS: Ipc["SETTINGS"] = {
    get: "settings:get",
    saveGithub: "settings:save-github",
    setTheme: "settings:set-theme",
    openLogs: "settings:open-logs",
    close: "settings:close",
  };

  const here = new URL(location.href);

  if (here.protocol === "app:" && here.host === "schema-studio" && here.pathname === "/settings.html") {
    const settings: import("../shared/ipc").SettingsApi = {
      get: () => ipcRenderer.invoke(SETTINGS.get),
      saveGithub: (input) => ipcRenderer.invoke(SETTINGS.saveGithub, input),
      setTheme: (choice) => ipcRenderer.send(SETTINGS.setTheme, choice),
      openLogs: () => ipcRenderer.send(SETTINGS.openLogs),
      close: () => ipcRenderer.send(SETTINGS.close),
    };
    contextBridge.exposeInMainWorld("schemaStudioSettings", settings);
  }
}
