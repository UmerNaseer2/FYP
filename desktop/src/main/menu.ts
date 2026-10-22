/**
 * The menu bar: File, Edit, View and Help.
 *
 * Edit is what makes the usual shortcuts work (cut, copy, paste, undo,
 * select all), since Electron only gives a window the shortcuts its menu
 * has. View holds zoom, full screen and the Appearance choice. Help is where
 * a person goes when something is wrong: the logs, diagnostics to share,
 * and which version this is.
 */
import { Menu, type MenuItemConstructorOptions } from "electron";

import type { ThemeChoice } from "../shared/ipc";

export type MenuState = {
  /** An installed copy has no developer tools. */
  packaged: boolean;
  /** Settings needs the app's keys, so it stays grayed out until they are open. */
  settingsAvailable: boolean;
  theme: ThemeChoice;
};

export type MenuActions = {
  openSettings(): void;
  setTheme(choice: ThemeChoice): void;
  openLogs(): void;
  copyDiagnostics(): void;
  showAbout(): void;
};

const THEMES: { choice: ThemeChoice; label: string }[] = [
  { choice: "system", label: "Match &Ubuntu" },
  { choice: "light", label: "&Light" },
  { choice: "dark", label: "&Dark" },
];

export function buildMenu(state: MenuState, actions: MenuActions): Menu {
  const mac = process.platform === "darwin";
  const view: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
    { type: "separator" },
    {
      label: "&Appearance",
      submenu: THEMES.map(
        ({ choice, label }): MenuItemConstructorOptions => ({
          label,
          type: "radio",
          checked: state.theme === choice,
          click: () => actions.setTheme(choice),
        }),
      ),
    },
  ];
  if (!state.packaged) view.push({ type: "separator" }, { role: "toggleDevTools" });

  const file: MenuItemConstructorOptions[] = [
    {
      label: "&Settings…",
      accelerator: "CmdOrCtrl+,",
      enabled: state.settingsAvailable,
      click: () => actions.openSettings(),
    },
  ];
  // On a Mac, Quit lives in the app's own menu instead.
  if (!mac) file.push({ type: "separator" }, { role: "quit" });

  const template: MenuItemConstructorOptions[] = [
    { label: "&File", submenu: file },
    { role: "editMenu" },
    { label: "&View", submenu: view },
    {
      label: "&Help",
      submenu: [
        { label: "Open &Logs", click: () => actions.openLogs() },
        { label: "&Copy Diagnostics", click: () => actions.copyDiagnostics() },
        { type: "separator" },
        { label: "&About Schema Studio", click: () => actions.showAbout() },
      ],
    },
  ];
  if (mac) template.unshift({ role: "appMenu" });
  return Menu.buildFromTemplate(template);
}
