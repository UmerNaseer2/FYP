/**
 * The preload script of the Settings window: what the Settings page may ask
 * the main process to do.
 *
 * Only app://schema-studio/settings.html gets anything. It may read the
 * settings, save the GitHub registry, change the theme, choose whether the
 * app keeps running with its window closed, starts at sign-in and shows
 * drift alerts, open the logs and close the window. Its Phone section runs
 * the phone link through `window.schemaStudioPhone`, and its Backup section
 * saves and restores backups through `window.schemaStudioBackup`. As in the
 * main window's preload (app-preload.ts), the main process checks every
 * message again before it acts on it, the message names are repeated here
 * because a sandboxed preload can load nothing but Electron, and the types
 * make the compiler check them against src/shared/ipc.ts.
 */
{
  const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
  type Ipc = typeof import("../shared/ipc");

  const SETTINGS: Ipc["SETTINGS"] = {
    get: "settings:get",
    saveGithub: "settings:save-github",
    setTheme: "settings:set-theme",
    setKeepRunning: "settings:set-keep-running",
    setStartAtLogin: "settings:set-start-at-login",
    setDriftAlerts: "settings:set-drift-alerts",
    openLogs: "settings:open-logs",
    close: "settings:close",
  };

  const PHONE: Ipc["PHONE"] = {
    get: "phone:get",
    changed: "phone:changed",
    paired: "phone:paired",
    setEnabled: "phone:set-enabled",
    setRelay: "phone:set-relay",
    setShared: "phone:set-shared",
    forget: "phone:forget",
    allowApprovals: "phone:allow-approvals",
    turnOffApprovals: "phone:turn-off-approvals",
    pair: "phone:pair",
    cancelPairing: "phone:cancel-pairing",
    connectNow: "phone:connect-now",
    connections: "phone:connections",
  };

  const BACKUP: Ipc["BACKUP"] = {
    save: "backup:save",
    choose: "backup:choose",
    restore: "backup:restore",
  };

  const here = new URL(location.href);

  if (here.protocol === "app:" && here.host === "schema-studio" && here.pathname === "/settings.html") {
    const settings: import("../shared/ipc").SettingsApi = {
      get: () => ipcRenderer.invoke(SETTINGS.get),
      saveGithub: (input) => ipcRenderer.invoke(SETTINGS.saveGithub, input),
      setTheme: (choice) => ipcRenderer.send(SETTINGS.setTheme, choice),
      setKeepRunning: (on) => ipcRenderer.send(SETTINGS.setKeepRunning, on),
      setStartAtLogin: (on) => ipcRenderer.invoke(SETTINGS.setStartAtLogin, on),
      setDriftAlerts: (on) => ipcRenderer.send(SETTINGS.setDriftAlerts, on),
      openLogs: () => ipcRenderer.send(SETTINGS.openLogs),
      close: () => ipcRenderer.send(SETTINGS.close),
    };
    contextBridge.exposeInMainWorld("schemaStudioSettings", settings);

    const phone: import("../shared/ipc").PhoneSettingsApi = {
      get: () => ipcRenderer.invoke(PHONE.get),
      onChange: (listener) => {
        ipcRenderer.on(PHONE.changed, (_event, view) => listener(view));
      },
      onPaired: (listener) => {
        ipcRenderer.on(PHONE.paired, (_event, name) => listener(name));
      },
      setEnabled: (enabled) => ipcRenderer.send(PHONE.setEnabled, enabled),
      setRelay: (origin) => ipcRenderer.invoke(PHONE.setRelay, origin),
      setShared: (ids) => ipcRenderer.send(PHONE.setShared, ids),
      forget: (key) => ipcRenderer.send(PHONE.forget, key),
      allowApprovals: (key) => ipcRenderer.send(PHONE.allowApprovals, key),
      turnOffApprovals: (key) => ipcRenderer.send(PHONE.turnOffApprovals, key),
      pair: () => ipcRenderer.invoke(PHONE.pair),
      cancelPairing: () => ipcRenderer.send(PHONE.cancelPairing),
      connectNow: () => ipcRenderer.send(PHONE.connectNow),
      connections: () => ipcRenderer.invoke(PHONE.connections),
    };
    contextBridge.exposeInMainWorld("schemaStudioPhone", phone);

    const backup: import("../shared/ipc").BackupSettingsApi = {
      save: (passphrase, repeat) => ipcRenderer.invoke(BACKUP.save, passphrase, repeat),
      choose: () => ipcRenderer.invoke(BACKUP.choose),
      restore: (passphrase) => ipcRenderer.invoke(BACKUP.restore, passphrase),
    };
    contextBridge.exposeInMainWorld("schemaStudioBackup", backup);
  }
}
